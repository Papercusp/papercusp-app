/**
 * Elite federation SEND seam — the WI-1564-guarded writer that stamps a local QD
 * archive elite `federatable` so it rides the peer-log
 * (federated-scout-gym-learning-2026-07-02 F1-4 / P-012, review H1/H7).
 *
 * The TWIN of {@link import('../../agent-facts/store').assertFact}'s shareable-fact
 * guard, on the elite side: both writers resolve their federation workspace
 * through the SAME {@link resolveFederationWorkspace} helper so they strand-or-
 * federate IDENTICALLY. A `federatable=true` stamp under the non-federating
 * coordination/'*' partition would fire mig 464's capture trigger but route
 * nowhere — the row is captured-then-stranded on every peer (the WI-1564 strand
 * class, the writer-side twin of the harness_slug drop D-007 fixed). So we REFUSE
 * LOUDLY rather than silently strand.
 *
 * Eligibility is the D-002 rule ({@link federatableElite}: outcome=won OR
 * grade>=4). A non-eligible elite is simply not stamped (no-op) — never an error.
 *
 * This is the guarded seam the gym accept / champion path calls to publish an
 * eligible elite (mig 464 comment). It stamps ONLY the LOCAL archive row
 * (`source_hive IS NULL`) — a receiver's foreign-elite rows live in
 * `gym_qd_foreign_elites` and are never re-federated.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { resolveFederationWorkspace, federatableElite } from '../../agent-facts/store';
import {
  signEliteOutcome,
  eliteOutcomeRecordId,
  type EliteOutcomeBasis,
} from './elite-outcome-record';

/**
 * F1-6 / P-014 (D-005 hole 3): the device-signing seam. When supplied,
 * {@link markEliteFederatable} ALSO builds a device-signed EliteOutcomeRecord
 * (elite-outcome-record.ts) and persists it into `gym_qd_archive.outcome_record`,
 * so every receiver can verify the outcome claim OFFLINE (verifyEliteOutcomeForElite)
 * instead of trusting the bare `federatable` boolean. The private key never leaves
 * the identity layer — the caller passes a `sign` closure (signWithDeviceKey binding)
 * + the matching device pubkey.
 */
export interface EliteOutcomeSigner {
  /** The authoring device's raw-32 Ed25519 pubkey (base64) — stamped into the record
   *  and re-derived by the receiver from the source log's admitted device (anti-lift). */
  devicePubkeyBase64: string;
  /** Sign the canonical outcome bytes with the device private key. */
  sign: (bytes: Buffer) => Promise<Buffer>;
}

export interface MarkEliteFederatableArgs {
  /** The operator workspace the local archive row lives in. */
  workspaceId: string;
  /** The Hive HOME slug the elite federates under (the archive row's harness_slug). */
  harnessSlug: string;
  /** The niche key identifying the local archive elite to publish. */
  nicheKey: string;
  /** D-002 eligibility inputs — outcome-verified or strongly graded only. */
  eligibility: { outcome?: string | null; grade?: number | null };
  /**
   * F1-6/P-014: when provided, ALSO sign a device-signed EliteOutcomeRecord over the
   * stamped row's {niche, candidate, outcome, grade, fitness} and store it in
   * `gym_qd_archive.outcome_record` — so the elite federates with its own verifiable
   * proof. ABSENT ⇒ federatable-only stamp (tier-1 backward-compatible: the column
   * stays NULL and the receiver treats the elite as outcome-UNVERIFIED, still admitted).
   */
  outcomeSigner?: EliteOutcomeSigner;
}

export interface MarkEliteFederatableResult {
  /** Whether the elite is now stamped federatable (rode the trigger). */
  federatable: boolean;
  /** 'stamped' | 'not-eligible' | 'no-row' — why the result is what it is. */
  reason: 'stamped' | 'not-eligible' | 'no-row';
  /** F1-6/P-014: the content-address of the signed outcome record, when one was
   *  produced (a signer was supplied AND the row existed). */
  outcomeRecordId?: string;
}

/**
 * Stamp a local QD-archive elite `federatable` so it federates — guarded so an
 * eligible elite can NEVER strand under a non-federating workspace (WI-1564).
 *
 * - Not eligible (D-002) ⇒ no-op, `{ federatable:false, reason:'not-eligible' }`.
 * - Eligible but the workspace does not federate ⇒ THROWS (loud refuse — the
 *   strand combo), mirroring assertFact.
 * - Eligible + federating workspace ⇒ `UPDATE ... SET federatable = true` on the
 *   LOCAL row; `{ federatable:true, reason:'stamped' }` (or 'no-row' if the niche
 *   has no local elite).
 */
export async function markEliteFederatable(
  args: MarkEliteFederatableArgs,
  inject?: Sql,
): Promise<MarkEliteFederatableResult> {
  if (!federatableElite(args.eligibility)) {
    return { federatable: false, reason: 'not-eligible' };
  }
  // WI-1564: an eligible elite stamped federatable in the coordination/'*'
  // partition captures (mig 464) then strands — refuse LOUDLY, the exact twin of
  // assertFact's shareable-fact guard.
  if (!resolveFederationWorkspace(args.workspaceId)) {
    throw new Error(
      `markEliteFederatable — an eligible elite cannot federate from the '${args.workspaceId}' ` +
        `workspace partition (WI-1564): the coordination/'*' partition never federates, so the ` +
        `elite would be captured then stranded on every peer. Publish from a hive-scoped workspace.`,
    );
  }
  const sql = inject ?? getOrgPg().sql;

  // BACKWARD-COMPATIBLE path (no signer): the original single-UPDATE stamp on the
  // LOCAL row (source_hive IS NULL — you federate YOUR OWN elite; foreign rows are
  // received into gym_qd_foreign_elites and never re-published). `outcome_record`
  // stays NULL; the receiver treats the elite as outcome-UNVERIFIED (still admitted).
  if (!args.outcomeSigner) {
    const rows = (await sql`
      UPDATE harness_shared.gym_qd_archive
         SET federatable = true
       WHERE workspace_id = ${args.workspaceId}
         AND harness_slug = ${args.harnessSlug}
         AND niche_key = ${args.nicheKey}
         AND source_hive IS NULL
      RETURNING niche_key`) as unknown as Array<{ niche_key: string }>;
    const stamped = Array.isArray(rows) && rows.length > 0;
    return { federatable: stamped, reason: stamped ? 'stamped' : 'no-row' };
  }

  // P-014 SIGNING path: stamp federatable AND return the fields the signed outcome
  // record binds (candidate_id, fitness) + the elite's op-ts (updated_at, a
  // Date.now-free deterministic clock). Then sign + persist the record.
  const rows = (await sql`
    UPDATE harness_shared.gym_qd_archive
       SET federatable = true
     WHERE workspace_id = ${args.workspaceId}
       AND harness_slug = ${args.harnessSlug}
       AND niche_key = ${args.nicheKey}
       AND source_hive IS NULL
    RETURNING candidate_id, fitness, updated_at`) as unknown as Array<{
    candidate_id: string;
    fitness: number | string;
    updated_at: number | string;
  }>;
  if (!Array.isArray(rows) || rows.length === 0) {
    return { federatable: false, reason: 'no-row' };
  }
  const row = rows[0];
  // The signed basis mirrors federatableElite (D-002): 'won' when the outcome is a
  // win, else 'graded' (guaranteed grade>=4 here, since federatableElite passed).
  const outcome: EliteOutcomeBasis = args.eligibility.outcome === 'won' ? 'won' : 'graded';
  const record = await signEliteOutcome(
    {
      nicheKey: args.nicheKey,
      candidateId: String(row.candidate_id),
      // Audit only — the trust anchor is the RECEIVER-STAMPED source log, not this.
      sourceHive: args.harnessSlug,
      outcome,
      grade: Number(args.eligibility.grade ?? 0),
      fitness: Number(row.fitness),
      devicePubkeyBase64: args.outcomeSigner.devicePubkeyBase64,
      nowMs: Number(row.updated_at),
    },
    args.outcomeSigner.sign,
  );
  await sql`
    UPDATE harness_shared.gym_qd_archive
       SET outcome_record = ${JSON.stringify(record)}::text::jsonb
     WHERE workspace_id = ${args.workspaceId}
       AND harness_slug = ${args.harnessSlug}
       AND niche_key = ${args.nicheKey}
       AND source_hive IS NULL`;
  return { federatable: true, reason: 'stamped', outcomeRecordId: eliteOutcomeRecordId(record) };
}
