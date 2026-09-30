/**
 * EI-21456558908416090 — is manual `release:checkpoint-run` authority currently withheld?
 *
 * One predicate, consulted by BOTH sides of the same lever:
 *   - `release:trace`          — must not RECOMMEND a verb a recorded decision forbids;
 *   - `release:checkpoint-run` — must not EXECUTE one.
 *
 * A recommender that disagrees with its executor is the defect this closes. Before it,
 * `release:trace` handed every reader `nextVerb: release:checkpoint-run` while the active plan
 * forbade exactly that, and green-checkpoint.ts:2566 records the cost of complying: a manual
 * fire inside a re-triage window DISCARDS the auto-refire rescue and spends a ~55min suite.
 *
 * The withholding is DATA, never a decision id in code. The predecessor of this module
 * hard-coded `'stable-candidate-related-gate-2026-08-23#D-053'` as the only recognized
 * authority, so the next decision to withhold the same lever (D-061) fell straight through and
 * the forbidden recommendation was re-issued — the identical defect one decision later
 * (EI-21411776375901170, then this item). Adding a second literal would have queued up a third.
 */
import type { ReleaseTraceManualRunAuthority } from '../release-trace';
import type { QualificationAdmission } from '../release-checkpoint-config';
import { readManualRunAdmission, readQualificationAdmission } from '../release-checkpoint-config';
import {
  readCheckpointSerializerAuthority,
  type CheckpointSerializerAuthority,
} from './checkpoint-serializer-authority';

/** Everything the classification depends on, so it can be exercised without a database. */
export interface ManualRunAuthorityEvidence {
  manualRun: QualificationAdmission;
  qualification: QualificationAdmission;
  serializer: CheckpointSerializerAuthority;
  /** The reader's own owner id, when resolvable. The serializer fence admits its own holder. */
  readerOwnerId?: string | null;
}

/**
 * Pure precedence. Order is most-specific-first so the reported `governingRef` names the
 * decision a reader would actually have to supersede.
 *
 * `unknown` admission is NOT treated as withheld here. This function answers for the
 * RECOMMENDER, which takes no action; the executor reads the same tokens and fails closed on
 * `unknown` itself (see `readManualRunAdmission`). Failing closed here as well would blank the
 * nextVerb of a diagnostic agents read precisely when the pipeline is already unhealthy, and
 * would do so on a transient DB blip.
 */
export function classifyManualRunAuthority(
  evidence: ManualRunAuthorityEvidence,
): ReleaseTraceManualRunAuthority | null {
  if (evidence.manualRun.status === 'held') {
    const hold = evidence.manualRun.hold;
    return {
      withheld: true,
      governingRef: hold.governingRef,
      source: 'manual-run-hold',
      reason:
        hold.reason?.trim() ||
        'A recorded decision withholds manual checkpoint-run authority; scheduled gate fires are unaffected.',
    };
  }

  if (evidence.qualification.status === 'held') {
    const hold = evidence.qualification.hold;
    return {
      withheld: true,
      governingRef: hold.governingRef,
      source: 'qualification-hold',
      // A qualification hold forbids any candidate from qualifying. Spending a ~55min manual
      // suite to produce a verdict that cannot be acted on is exactly the waste it exists to
      // prevent, so it withholds the manual lever too.
      reason:
        (hold.reason?.trim() ? `${hold.reason.trim()} ` : '') +
        'A qualification hold is active, so no candidate may qualify and a manual full-suite run cannot produce an actionable verdict.',
    };
  }

  // Mirror the executor's own fence rather than restating its policy: release:checkpoint-run
  // refuses with `serializer_authority_held` for every caller except the serializer itself, and
  // force/replaceStale/waitForEligibility cannot bypass it. Recommending a verb that provably
  // refuses is the same defect in a quieter form.
  if (evidence.serializer.status === 'held' && evidence.readerOwnerId !== evidence.serializer.ownerId) {
    return {
      withheld: true,
      governingRef: evidence.serializer.itemId,
      source: 'serializer-fence',
      reason:
        `${evidence.serializer.itemId} holds the exclusive D-016 checkpoint serializer fence for ` +
        `${evidence.serializer.ownerId}; only that owner may run the manual checkpoint while the quiescence pause is active.`,
    };
  }

  return null;
}

/**
 * Read every live authority once and classify. Never throws: each underlying reader already
 * reports its own failure in-band (`unknown` / `unreadable`), and this is called from a
 * diagnostic whose job is to stay answerable when the pipeline is not.
 */
export async function resolveManualRunAuthority(
  opts: { readerOwnerId?: string | null; workspaceId?: string } = {},
): Promise<ReleaseTraceManualRunAuthority | null> {
  const [manualRun, qualification, serializer] = await Promise.all([
    readManualRunAdmission({ workspaceId: opts.workspaceId }),
    readQualificationAdmission({ workspaceId: opts.workspaceId }),
    readCheckpointSerializerAuthority({ workspaceId: opts.workspaceId }),
  ]);
  return classifyManualRunAuthority({
    manualRun,
    qualification,
    serializer,
    readerOwnerId: opts.readerOwnerId ?? null,
  });
}
