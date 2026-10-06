/**
 * P-006 (frozen-candidate-compliance-enforcement-2026-08-30): a completion claim of the form
 * "fixed N gate reds" must not be assertable when the fixes are not in the sha being judged.
 *
 * THE CLAIM THIS CATCHES. While the gate is frozen, a fix committed to staging lands ABOVE
 * the candidate under judgment. The agent's work is real, their tests pass, and the gate
 * still cannot see any of it — so "I fixed the gate reds" is locally true and globally
 * false. Measured 2026-08-30: 3 of 10 reds on candidate 4184805d were already fixed at tip
 * and re-reported as outstanding. Nothing in the completion path noticed, because every
 * evidence field was individually valid.
 *
 * WHY IT BELONGS AT COMPLETION TIME. The P-004 hook fires at the EDIT, which is the cheapest
 * moment — but an agent who dismisses it, or who never edited (a peer's fix, a rebase), still
 * reaches the completion call. This is the second, independent net, and it is the one that
 * stops the false claim entering the record where a successor inherits it as fact.
 *
 * SHAPE. Deliberately a sibling of `unresolvedPathsInCompletion`: pure via an injected probe,
 * WARN-ONLY, and fail-open at every step (EI-24 record-and-warn discipline). Editing a
 * failing path is often exactly right; asserting the gate can see it is the error. Silence
 * whenever it cannot judge — no marker, no declared paths, no containment probe.
 */
import { containmentForPaths, integrationBranch, type PathContainment } from './judged-sha-containment';
import { integrationRoot } from '../release-deploy-launch';
import {
  normalizeRepoPath,
} from './frozen-candidate-repair-queue';
import {
  readFrozenRepairMarker,
  type FrozenRepairEditMarker,
  type FrozenRepairMarkerLeg,
} from './frozen-repair-edit-marker';
import type { GateVerdictTarget } from './gate-verdict-target';
import { renderAdmitCommand } from './repair-manifest';

/**
 * Phrasings that assert gate progress. Kept narrow on purpose: a false positive here
 * nags a correct close, and a nagging check is one agents learn to ignore.
 *
 * This is deliberately an ACTION + GATE-RED matcher rather than a bare gate-red
 * vocabulary matcher. The old regex matched a red-state observation (`Gate red 94`)
 * and identifiers such as `gate-reds-mostly-unowned` exactly like a completion claim.
 * A progress assertion needs a completed-action verb next to a standalone gate-red
 * phrase, or one of the two explicit green-gate forms.
 */
const GATE_RED_TERM = String.raw`(?<![\w-])(?:gate[- ]reds?|red gates?|checkpoint reds?|green[- ]checkpoint reds?)(?![\w-])`;
const GATE_PROGRESS_ACTION = String.raw`(?:fixed|cleared|resolved|repaired|passed|promoted|unblocked)`;
const GATE_RED_CLAIM_RE = new RegExp(
  [
    String.raw`\b${GATE_PROGRESS_ACTION}\s+(?:\d+(?:\s+of\s+\d+)?\s+)?(?:the\s+|a\s+|an\s+|all\s+)?${GATE_RED_TERM}`,
    String.raw`${GATE_RED_TERM}\s+(?:was\s+|were\s+)?${GATE_PROGRESS_ACTION}\b`,
    String.raw`\bgreened\s+(?:the\s+)?gate\b`,
    String.raw`\bthe\s+gate\s+(?:is|was|went|turned)\s+green\b`,
  ].join('|'),
  'i',
);

/** Remove prose mentions that are data, not assertions (code spans and quotes). */
function maskQuotedOrCodeSegments(text: string): string {
  return text.replace(/`[^`\n]*`|"[^"\n]*"/g, (segment) => ' '.repeat(segment.length));
}

export interface GateRedClaimEvidence {
  filesChanged?: string[];
  summary?: string;
  testsRun?: string;
  testResult?: string;
  verifiedHow?: string;
}

export interface GateRedClaimProbe {
  /** Injected for tests; omitted means "read the real marker". */
  marker?: FrozenRepairEditMarker | null;
  /** Exact workspace/install scope for the live marker read. */
  target?: GateVerdictTarget | null;
  containment?: (paths: string[], judgedSha: string) => PathContainment[];
}

/** Does this completion assert gate progress at all? */
export function looksLikeGateRedFixClaim(evidence: GateRedClaimEvidence | undefined): boolean {
  if (!evidence) return false;
  const haystack = [
    evidence.summary,
    evidence.testsRun,
    evidence.testResult,
    evidence.verifiedHow,
  ]
    .filter((v): v is string => typeof v === 'string')
    .join('\n');
  return GATE_RED_CLAIM_RE.test(maskQuotedOrCodeSegments(haystack));
}

export interface GateRedClaimWarning {
  judgedSha: string;
  candidate: string;
  /** Declared paths that are in the failing set but NOT carried by the judged sha. */
  uncontainedPaths: string[];
  /** Declared paths that are in the failing set and ARE carried by the judged sha. */
  containedPaths: string[];
  detail: string;
}

/**
 * The warning, or `undefined` when there is nothing to say.
 *
 * Note the deliberate narrowing: only declared paths that are ALSO in the frozen candidate's
 * failing set are judged. A gate-red close that touched unrelated files is not this bug, and
 * flagging it would be the false positive that gets the whole check ignored.
 */
export function gateRedCompletionClaimWarning(
  evidence: GateRedClaimEvidence | undefined,
  probe: GateRedClaimProbe = {},
): GateRedClaimWarning | undefined {
  try {
    if (!looksLikeGateRedFixClaim(evidence)) return undefined;
    const declared = evidence?.filesChanged?.filter((f) => typeof f === 'string' && f.trim());
    if (!declared?.length) return undefined;

    const marker = 'marker' in probe ? probe.marker : readFrozenRepairMarker(probe.target);
    // No frozen queue ⇒ the candidate is cut at tip ⇒ an ordinary commit IS the judged
    // lineage, so the claim is unremarkable. Silence, not a guess.
    if (!marker) return undefined;

    const failing = new Set(marker.failingPaths.map(normalizeRepoPath));
    const relevant = [
      ...new Set(declared.map(normalizeRepoPath).filter((p) => p.length > 0 && failing.has(p))),
    ].sort();
    if (!relevant.length) return undefined;

    const check =
      probe.containment ??
      ((paths: string[], judgedSha: string) =>
        containmentForPaths(paths, judgedSha, integrationRoot(), undefined, integrationBranch()));
    const rows = check(relevant, marker.repairHead);
    const uncontainedPaths = rows.filter((r) => !r.containedInJudgedSha).map((r) => r.path).sort();
    const containedPaths = rows.filter((r) => r.containedInJudgedSha).map((r) => r.path).sort();
    if (!uncontainedPaths.length) return undefined;

    return {
      judgedSha: marker.repairHead,
      candidate: marker.candidate,
      uncontainedPaths,
      containedPaths,
      detail:
        `⚠ GATE-PROGRESS CLAIM THE GATE CANNOT SEE: this completion asserts gate-red progress, but ` +
        `${uncontainedPaths.length} of the frozen candidate's failing path(s) you named are NOT carried ` +
        `by the sha under judgment (${marker.repairHead.slice(0, 12)}, frozen candidate ` +
        `${marker.candidate.slice(0, 12)}): ${uncontainedPaths.join(', ')}. ` +
        `The fix is real but it landed ABOVE the judged sha, so the gate will keep reporting these red. ` +
        `Put it on the judged lineage with release:repair-queue { op:'admit', paths:[...] }, then ` +
        `re-state the claim with the containment verdict as its evidence.`,
    };
  } catch {
    return undefined; // fail open — a detector fault must never block a close
  }
}

/**
 * P-022 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, D-007 #3): the REFUSAL
 * form of the check above.
 *
 * The Aug-30 warning proved the claim class is real and that a warning does not stop it —
 * the false record still enters the ledger and a successor inherits it as fact. D-007 #3
 * rules that `work_items:complete` on a gate-red condition item, or on any completion whose
 * prose claims a gate red fixed, REFUSES unless the admission ledger holds the claimed paths
 * on the current lineage AND the leg reads admitted or green.
 *
 * Evidence source: the frozen-repair marker, which the ONE queue write path projects beside
 * the queue row (`admittedPaths` = admissions[].paths ∪ unchanged; `legs` = the P-021
 * manifest's statuses). Reading the projection keeps this check synchronous, DB-free and
 * fail-open on a detector fault, exactly like its sibling — while still answering from the
 * lineage the gate will judge rather than from staging's tip.
 *
 * Silence rules (deliberate): no claim ⇒ allow; no frozen queue ⇒ allow (an ordinary commit
 * IS the judged lineage); a claim that names only paths outside the red radius ⇒ allow (not
 * this bug). Everything else is decided, and the refusal names the exact admit command.
 */
export type GateRedClaimVerdict =
  | {
      refuse: false;
      reason: 'no-claim' | 'no-frozen-queue' | 'no-relevant-paths' | 'admitted' | 'detector-fault';
      candidate?: string;
      judgedSha?: string;
      admittedPaths?: string[];
    }
  | {
      refuse: true;
      reason: 'unadmitted-paths' | 'legs-still-red' | 'paths-required';
      candidate: string;
      judgedSha: string;
      /** Claimed paths in the red radius that the admission ledger does NOT carry (or whose leg is still red). */
      unadmittedPaths: string[];
      /** Manifest legs still red at the judged lineage. */
      redLegs: FrozenRepairMarkerLeg[];
      /** The exact command that lands the unadmitted paths; null when no path is known. */
      admitCommand: string | null;
      detail: string;
    };

export interface GateRedClaimVerdictOptions {
  /**
   * The item being completed IS the gate-red condition singleton (`gate-red-streak:<harness>` /
   * `frozen-repair-convergence:<pipeline>`). Closing it asserts the gate is green, so every
   * manifest leg must read admitted or green regardless of what the prose says.
   */
  gateRedConditionItem?: boolean;
  /**
   * The close is an administrative settlement (a duplicate or explicit drop/discard), not a
   * claim that the gate is green. This only exempts the condition-item-wide assertion; an
   * explicit prose claim with declared failing paths still goes through the normal lineage
   * check below.
   */
  administrativeSettlement?: boolean;
  /** Injected for tests; omitted means "read the real marker". */
  marker?: FrozenRepairEditMarker | null;
  /** Exact workspace/install scope for the live marker read. */
  target?: GateVerdictTarget | null;
}

const legStatusByPath = (legs: readonly FrozenRepairMarkerLeg[]): Map<string, FrozenRepairMarkerLeg['status']> => {
  const out = new Map<string, FrozenRepairMarkerLeg['status']>();
  for (const leg of legs) {
    for (const p of leg.subjectPaths) {
      const prev = out.get(p);
      // A path named by two legs is only "done" when BOTH are: red wins, then admitted, then green.
      if (prev === 'red' || leg.status === 'red') out.set(p, 'red');
      else if (prev === 'admitted' || leg.status === 'admitted') out.set(p, 'admitted');
      else out.set(p, 'green');
    }
  }
  return out;
};

export function gateRedCompletionClaimVerdict(
  evidence: GateRedClaimEvidence | undefined,
  opts: GateRedClaimVerdictOptions = {},
): GateRedClaimVerdict {
  try {
    const prosaicClaim = looksLikeGateRedFixClaim(evidence);
    const conditionItem = opts.gateRedConditionItem === true;
    const administrativeSettlement = opts.administrativeSettlement === true;
    if (!prosaicClaim && !conditionItem) return { refuse: false, reason: 'no-claim' };

    const marker = 'marker' in opts ? opts.marker : readFrozenRepairMarker(opts.target);
    if (!marker) return { refuse: false, reason: 'no-frozen-queue' };

    const candidate = marker.candidate;
    const judgedSha = marker.repairHead;
    const admitted = new Set(marker.admittedPaths.map(normalizeRepoPath).filter((p) => p.length > 0));
    const statusByPath = legStatusByPath(marker.legs);
    const redLegs = marker.legs.filter((l) => l.status === 'red');
    const radius = new Set<string>([
      ...marker.failingPaths.map(normalizeRepoPath),
      ...marker.legs.flatMap((l) => l.subjectPaths),
    ]);
    radius.delete('');

    const refusalTail =
      ` The fix may be real, but the gate judges frozen candidate ${candidate.slice(0, 12)} at ` +
      `${judgedSha.slice(0, 12)} — nothing reaches it until admitted (D-007). After git-sync commits ` +
      `your edit, run the admit command, then re-send this completion citing the admission. ` +
      `No completion record or state transition was written.`;

    // Closing the gate-red condition item asserts the WHOLE gate is green: every leg must
    // read admitted or green at the judged lineage. An administrative duplicate/drop
    // settlement does not make that assertion, so it falls through to the ordinary prose
    // claim check below (which still refuses an explicit gate-green claim). A pre-P-021
    // marker (no legs) also falls through to the path check below.
    if (conditionItem && !administrativeSettlement && redLegs.length > 0) {
      const pathless = redLegs.filter((l) => l.subjectPaths.length === 0);
      const paths = [...new Set(redLegs.flatMap((l) => l.subjectPaths))].sort();
      return {
        refuse: true,
        reason: 'legs-still-red',
        candidate,
        judgedSha,
        unadmittedPaths: paths,
        redLegs,
        admitCommand: paths.length ? renderAdmitCommand(paths) : null,
        detail:
          `⛔ GATE-RED CLOSE REFUSED: this is the gate-red condition item, and ${redLegs.length} ` +
          `manifest leg(s) still read red-at-candidate on the judged lineage: ` +
          `${redLegs.map((l) => l.legId).join(', ')}.` +
          (paths.length ? ` Their subject paths: ${paths.join(', ')}.` : '') +
          (pathless.length ? ` ${pathless.length} leg(s) name no subject path — admit the files you fixed by hand.` : '') +
          refusalTail,
      };
    }

    const declared = [
      ...new Set(
        (evidence?.filesChanged ?? [])
          .filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
          .map(normalizeRepoPath)
          .filter((p) => p.length > 0),
      ),
    ].sort();
    const relevant = declared.filter((p) => radius.has(p));

    if (relevant.length === 0) {
      // A prose gate-progress claim with NO paths in the red radius while legs are still red:
      // there is nothing the ledger can hold, so the claim is unfalsifiable as written. Ask
      // for the paths rather than let "fixed the gate reds" enter the record on its own.
      if (prosaicClaim && declared.length === 0 && redLegs.length > 0) {
        const paths = [...new Set(redLegs.flatMap((l) => l.subjectPaths))].sort();
        return {
          refuse: true,
          reason: 'paths-required',
          candidate,
          judgedSha,
          unadmittedPaths: paths,
          redLegs,
          admitCommand: paths.length ? renderAdmitCommand(paths) : null,
          detail:
            `⛔ GATE-PROGRESS CLAIM REFUSED: this completion asserts gate-red progress but names no ` +
            `filesChanged, while ${redLegs.length} manifest leg(s) still read red on the judged lineage ` +
            `(${redLegs.map((l) => l.legId).join(', ')}). Name the repo-relative paths you fixed in ` +
            `filesChanged so the claim can be checked against the admission ledger.` +
            refusalTail,
        };
      }
      return { refuse: false, reason: 'no-relevant-paths', candidate, judgedSha, admittedPaths: [...admitted].sort() };
    }

    const unadmittedPaths = relevant.filter((p) => !admitted.has(p) || statusByPath.get(p) === 'red');
    if (unadmittedPaths.length === 0) {
      return { refuse: false, reason: 'admitted', candidate, judgedSha, admittedPaths: relevant };
    }
    const notInLedger = unadmittedPaths.filter((p) => !admitted.has(p));
    const legStillRed = unadmittedPaths.filter((p) => admitted.has(p));
    return {
      refuse: true,
      reason: 'unadmitted-paths',
      candidate,
      judgedSha,
      unadmittedPaths,
      redLegs,
      admitCommand: renderAdmitCommand(unadmittedPaths),
      detail:
        `⛔ GATE-PROGRESS CLAIM REFUSED: this completion asserts gate-red progress, but ` +
        `${unadmittedPaths.length} of the red-radius path(s) it names ` +
        (notInLedger.length
          ? `are NOT in the admission ledger on the judged lineage (${notInLedger.join(', ')})`
          : '') +
        (notInLedger.length && legStillRed.length ? ' and ' : '') +
        (legStillRed.length
          ? `are admitted but their leg still reads red (${legStillRed.join(', ')} — the re-verify has not passed yet; wait for the gate's next tick)`
          : '') +
        `. Admit with: ${renderAdmitCommand(unadmittedPaths)}.` +
        refusalTail,
    };
  } catch {
    // A detector fault must never block a close (EI-24) — but say so, rather than reading as "allowed".
    return { refuse: false, reason: 'detector-fault' };
  }
}
