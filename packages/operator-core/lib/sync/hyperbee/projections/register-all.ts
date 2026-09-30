/**
 * Single-call wire-up for all 8 per-harness Hyperbee projections.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-031.
 *
 * Production call site (when instrumentation-node.ts boot wiring lands):
 *
 *   for (const harness of resolvedHarnesses) {
 *     registerAllHarnessProjections({
 *       workspaceId,
 *       harnessSlug: harness.slug,
 *     });
 *   }
 *
 * The substrate's `applyHyperbeeOpToPg(op)` then dispatches each
 * Hyperbee op to the right per-table writer/deleter.
 *
 * Decoupled from boot wiring so it can be tested in isolation and so
 * the boot path stays small.
 */

import {
  registerProjection,
  applyOpVia,
  buildStoredOrderPrefetch,
  buildSupersedablePut,
  type TableProjection,
  type ProjectionLookup,
  type ApplyOpOpts,
  type StoredOrderPrefetch,
  type SupersedablePut,
} from '../projection';
import type { OpEnvelope } from '../op-envelope-types';
import type { PendingMembershipContent } from '../pending-membership-content';
import { bumpFederationRefusedOp } from '../federation-refused-op-counter';
import { buildContributorsProjection } from './contributors';
import { buildFeatureClaimsProjection } from './feature-claims';
import { buildFeatureQueueProjection } from './feature-queue';
import { buildFeatureWorkingSetProjection } from './feature-working-set';
import { buildHarnessFeaturesProjection } from './harness-features';
import { buildHarnessPlansProjection } from './harness-plans';
import { buildIssuesProjection } from './issues';
import { buildPresenceProjection } from './presence';
import { buildUsageProjection } from './usage';
import { buildCoordConversationProjection } from './coord-conversation';
import { buildCoordMessageProjection } from './coord-message';
import { buildCoordThreadProjection } from './coord-thread';
import { buildCoordThreadPostProjection } from './coord-thread-post';
import { buildPlanItemAssignmentsProjection } from './plan-item-assignments';
import { buildHiveSettingsProjection } from './hive-settings';
// F1-1 (federated-scout-gym-learning-2026-07-02): shareable standing facts.
import { buildAgentFactsProjection } from './agent-facts';
// mem0-cross-machine-federation-2026-07-10: shareable memories (F1-1 mirror).
import { buildMemoriesProjection } from './p2p-memories';
// F1-2/F1-5 (federated-scout-gym-learning-2026-07-02): foreign QD elites.
import { buildGymQdElitesProjection } from './gym-qd-elites';
import { buildBeeClaimSpecProjection } from './bee-claim-spec';
import { buildGateVerdictProjection } from './gate-verdicts';
import { buildHivePolicyProjection } from './hive-policy';
import { buildFleetDirectoryProjection } from './fleet-directory';
import { buildWorkOffersProjection } from './work-offers';
import { buildFleetLeaderLeaseProjection } from './fleet-leader-leases';
import { buildHiveReportsProjection } from './hive-reports';
import { buildHivePendingJoinsProjection } from './hive-pending-joins';
import { buildP2pPeerGrantsProjection } from './p2p-peer-grants';
import { buildP2pReceiptsProjection } from './p2p-receipts';
import { buildHiveMembersProjection } from './hive-members';
import { buildHiveEpochKeysProjection } from './hive-epoch-keys';
import { buildEngineerIssuesProjection } from './engineer-issues';
import { buildHarnessPlanPartsProjection, type PlanPartsRecomposeBatch } from './harness-plan-parts';

export interface RegisterAllOpts {
  workspaceId: string;
  harnessSlug: string;
  /**
   * WI-3985: boot-owned, per-merge-pass snapshot of the memory federation
   * receive gate. Keeping the resolver on the registration opts lets every
   * rebuilt scoped/global projection observe the same immutable value for a
   * pass instead of racing independent live flag reads mid-fold.
   */
  memoryFederationFlagOn?: () => Promise<boolean>;
  /**
   * Test/multi-peer seam — thread a specific postgres-js client into every
   * projection writer instead of the process-global `getOrgPg().sql`.
   * Production leaves this undefined. (p2p-perf projection-write-cost bench
   * + multi-peer integration tests.)
   */
  sql?: import('postgres').Sql;
  /**
   * G1 Provenance (P-002): the own log's hex keyHex. When provided,
   * `buildHarnessProjectionApply` threads it into `applyOpVia` so ops from
   * the own log are stamped `origin='local'` and ops from admitted remote
   * logs are stamped `origin='remote'`. The global-registry path
   * (`registerAllHarnessProjections`) does not use this field because it
   * dispatches through `applyHyperbeeOpToPg`, not the scoped apply.
   */
  ownLogKeyHex?: string;
  /**
   * A-003 (shared-pot-release-testing Brief I): the HIVE-HOME slug to scope the
   * two hive-home-grained projections — `hive_members` + `hive_settings` — to,
   * INSTEAD of `harnessSlug`. The other ~16 projections always stay on
   * `harnessSlug`.
   *
   * Why: those two tables demux on the hive-HOME slug (the op carries
   * `pot_home_slug`/`harness_slug` = the Hive's home), but a JOINER boots a
   * MEMBER harness, so a member-slug-bound projection drops every hive-home-scoped
   * op the member's merge reads off the shared Hive topic — the member-list +
   * settings never reach the joiner, AND `loadRevokedHivePubkeys(<home>)` finds an
   * empty set so a revoked member is never refused by the joiner's admission union
   * (the revocation half). Binding ONLY these two to the home slug lets the
   * already-running member merge land them. Boot sets this for a `remote_hive`
   * (joined) view, AND — WI-3734 — for an OWNED hive's member harness (home ≠ own
   * slug, hive owned locally): without the rebind the owner-side member fold
   * demux-dropped every home-grained op a PEER member drained (B→A settings/members
   * silently lost). The double-apply the owned case risks (re-applying the owner's
   * own rows as `origin='remote'`) is prevented by `resolveHomeLogKeyHex` below —
   * boot threads it together with this rebind. Undefined ⇒ today's behavior
   * (member-slug binding for all projections).
   */
  potHomeSlug?: string;
  /**
   * WI-3734 (owned-hive owner-side fold): lazily resolve the LOCALLY-BOOTED
   * hive-home harness's own-log keyHex — non-null iff the home harness is booted
   * in THIS process (an OWNED hive; a joined hive's home is remote and never
   * resolves). Boot threads it whenever the hive-home rebind engages for a MEMBER
   * harness (home ≠ own slug). The hiveScoped projections' apply guard SKIPS an op
   * whose receiver-stamped `sourceLogKeyHex` matches: the home's own fold owns its
   * own-log ops (they land in PG at write time via the CDC capture), so re-applying
   * them at the member scope would double-apply the owner's rows as
   * `origin='remote'` — the WI-2105/WI-559 fear that previously blocked this rebind
   * entirely. Lazy because the home may boot AFTER the member (boot order is not
   * guaranteed); resolved per-op at apply time. For a JOINED hive it returns null
   * and nothing is excluded — the joiner MUST apply home-log ops (that is the
   * A-003 rebind's whole point).
   */
  resolveHomeLogKeyHex?: () => string | null;
  /**
   * WI-2105 REV (no-hiveHome fix): the hive-home the MEMBER-CONTENT GUARD resolves
   * its member set from — DECOUPLED from `potHomeSlug` (the projection-rebind home
   * above). The guard needs a home for ANY hive-peered harness that folds cross-member
   * content, INCLUDING an OWNED hive's MEMBER harness (the owner running a canary member
   * of its own hive: `hive_slug` resolves the home but home !== own slug, and the hive is
   * owned-not-remote, so `potHomeSlug` stayed undefined and `decideMemberContentOp` dropped
   * EVERY cross-member op with 'no-hiveHome'; PG-proven tower-VM REV break). It overrides
   * ONLY the content projections' guard potHomeSlug (via `guardScoped`) — it does NOT
   * touch `hiveScoped`. (WI-3734: the owned-hive member now rebinds the hive-home
   * projections too, but via `potHomeSlug` + the `resolveHomeLogKeyHex` home-log
   * exclusion above — never via this field.) Undefined falls back to `potHomeSlug`
   * (today's behavior).
   */
  memberContentHiveHome?: string;
  /**
   * shared-hive-rekey-2026-06-19 (drain hook): fired `(potHomeSlug, epoch)` when a
   * `hive_epoch_keys` row applies, so the apply loop can drain J's PendingEpochContent for
   * that `(hive, epoch)` + re-apply the deferred content (now decryptable). Boot wires this
   * when the re-key is active; undefined otherwise (no drain — the buffer just isn't fed).
   * Flows to `buildHiveEpochKeysProjection` via the `hiveScoped` spread (the other
   * projections ignore the extra field).
   */
  onEpochKeyApplied?: (potHomeSlug: string, epoch: number) => void;
  /**
   * WI-259 P-002 (membership-aware cross-member content apply): maps an op's
   * `sourceLogKeyHex` (the immutable, receiver-stamped source-log core key) → the
   * device-identity pubkey that was admission-VERIFIED for that log (∈ hive members at
   * admit). The 6 content projections' membership-aware writeToPg guard
   * (`shouldApplyMemberContentOp`) calls this with `op.sourceLogKeyHex` and re-checks the
   * device ∈ the CURRENT member set. Boot wires it from `admittedIdentities`; undefined
   * for non-hive / single-harness contexts (the guard then degrades to today's own-slug
   * drop). NOT keyed off `op.author_pubkey` — that field is caller-supplied / spoofable.
   */
  resolveAuthorDevice?: (sourceLogKeyHex: string) => string | null;
  /**
   * WI-259 P-004 (content-before-membership defer/replay): the per-apply-loop buffer for
   * cross-member content ops the P-002 guard would DROP only because the author's `hive_members`
   * row hasn't federated to this peer YET. Threaded into BOTH the 6 content projections (which
   * `defer` into it at the guard drop) AND the hive_members projection (which `drainForDevices`
   * + re-applies on a member apply — the onMemberApplied hook). Boot creates one per harness and
   * wires it here; undefined ⇒ today's drop (no buffer). The content projections receive it via
   * `opts`; hive_members receives it via the `hiveScoped` spread.
   */
  pendingMemberContent?: PendingMembershipContent;
  /**
   * WI-2142064: plan-parts recompose coalescing. When boot threads a batch here it
   * flows straight through `guardScoped` into `buildHarnessPlanPartsProjection`
   * (same field name — see HarnessPlanPartsProjectionOpts.recomposeBatch), and every
   * OTHER projection ignores the extra field. Undefined ⇒ today's per-op recompose.
   */
  recomposeBatch?: PlanPartsRecomposeBatch;
}

/**
 * The table tags this helper registers. Kept here as a named
 * constant so callers + tests can assert coverage without hard-
 * coding the literal list.
 */
export const REGISTERED_PROJECTION_TAGS = [
  'contributors',
  'claims',
  'queue',
  'working-set',
  'features-by-id',
  'plans-by-slug',
  'issues',
  'presence',
  'usage',
  // distributed-coordination-shared-harness-2026-06-04 (Track A): harness-scoped
  // coordination conversations federate over the peer-log.
  'coord-conversations',
  // distributed-coordination-shared-harness-2026-06-04 (Track A, surface #1):
  // harness-scoped coord messages/handoffs/escalations federate over the peer-log.
  'coord-messages',
  // distributed-coordination-shared-harness-2026-06-04 (Track A): conversation
  // reply timeline — thread header + posts.
  'coord-threads',
  'coord-thread-posts',
  // plan-item-assignment-claim-liveness-2026-06-04 (D-002): per-plan-item ASSIGNMENT
  // federates as content (the leased CLAIM is authority-mediated, never federated).
  'item-assignments',
  // shared-hive-federation-2026-06-08 (P-005): per-Hive settings federate as Hive
  // state, scoped to the Hive home harness slug (rides the Hive-pubkey topic, P-004).
  'hive-settings-by-key',
  // federated-scout-gym-learning-2026-07-02 (F1-1): shareable standing facts —
  // hive-home-grained, epoch-encrypted content, source-partitioned on apply (H6).
  'agent-facts-by-key',
  // mem0-cross-machine-federation-2026-07-10 (F1-1 mirror): shareable memories —
  // hive-home-grained, epoch-encrypted content, source-partitioned on apply (H6).
  'p2p-memories-by-id',
  // federated-scout-gym-learning-2026-07-02 (F1-2/F1-5): foreign QD elites —
  // hive-home-grained, epoch-encrypted content; receive side writes ONLY the
  // provenance-keyed gym_qd_foreign_elites (mig 465), never the local archive.
  'gym-qd-elites-by-niche',
  'bee-claim-specs',
  // cross-machine-coord-parity-and-trust-2026-07-01 (P-044 DG-1): the distributed
  // test gate's device-signed verdict facts — hive-home-grained, content-addressed,
  // INSERT-only. The projection verifies sig + content address + signer membership.
  'gate-verdicts',
  // shared-hive-owner-enforcement-2026-06-19 (EN-1): the owner-SIGNED Hive policy
  // record federates as Hive state, scoped to the Hive home (like hive_settings). The
  // projection verifies the owner signature before applying.
  'hive-policy',
  // shared-hive-owner-enforcement-2026-06-19 (EN-3): the member→owner moderation report
  // queue (P-MOD) + the approval-mode pending-join queue (P-MEMBER) federate as Hive
  // state, scoped to the Hive home (like hive_settings/hive_policy).
  'hive-reports',
  'hive-pending-joins',
  // shared-hive-federation-2026-06-08 (P-006): per-Hive contributor/device admission
  // (hive_members) federates across the Hive's Swarms so a revocation propagates.
  'hive-members',
  // shared-hive-rekey-2026-06-19 (P-005): per-member WRAPPED epoch keys for the read-plane
  // re-key (hive-epoch-keys.ts). Hive-home-grained. DARK until papercusp-hive-rekey flips.
  'hive-epoch-keys',
  // fed-reanchor B5: the work-queue's issue/task family (engineer_issues, work_items
  // kind ∈ bug|change|task) federates over the Hive peer-log. The capture trigger
  // (mig 197) derives the federation slug from `scope` + stamps it as harness_slug.
  'engineer-issues',
  // plan-federation-regrain-2026-06-13 P-006: per-PART plan federation (tableTag
  // 'plan-parts'). Additive + DARK — receives nothing until papercusp-plan-part-federation
  // is on (capture is flag-gated) and its harness_plans recompose is itself flag-gated.
  'plan-parts',
  // p2p-work-distribution-2026-07-02 P-001: P2P capability grants — hive-home-grained,
  // receiver-enforced (author attestation == grantor). Inert until grants are authored.
  'p2p-peer-grants',
  // p2p-work-distribution-2026-07-02 P-004: loud-refusal receipt facts — hive-home-
  // grained, INSERT-only, receiver-enforced (author attestation == responder).
  'p2p-receipts',
  // p2p-work-distribution-2026-07-02 P-101 (D-006): the owner-SIGNED fleet directory —
  // hive-home-grained, receiver-verified (attested-device sig; hive key only for the
  // H10 force-archive). Inert until records are authored.
  'p2p-fleet-directory',
  // p2p-work-distribution-2026-07-02 P-102 store leg (WI-1935): the publisher-SIGNED
  // offer store — hive-home-grained, receiver-verified (attested-device sig must
  // resolve to the record's publisher). Inert until offers are authored (the D-005
  // seat-offer publish on resource:delegate is the first production author).
  'p2p-work-offers',
  // P-302 LIVE-2 seam 1: fleet leader lease hints are hive-home-grained and
  // peer-log-backed so every machine reads the same incumbent before recompute.
  'p2p-fleet-leader-leases',
] as const;

export type RegisteredProjectionTag = (typeof REGISTERED_PROJECTION_TAGS)[number];

/**
 * WI-3734: apply-guard wrapped around every hive-home-grained (`hiveScoped`)
 * projection when boot threads `resolveHomeLogKeyHex` (the owned-hive member
 * rebind). Two duties:
 *
 *  - HOME-LOG EXCLUSION: skip ops sourced from the locally-booted home's own log
 *    — the home fold owns them (CDC capture already landed the rows in PG), so
 *    re-applying at the member scope would double-apply the owner's rows as
 *    `origin='remote'`. Keyed on the RECEIVER-STAMPED `provenance.sourceLogKeyHex`
 *    (unforgeable), the same signal `skipOwnOps` uses for the own log. For a
 *    JOINED hive the resolver returns null (home is remote, never locally booted)
 *    and nothing is excluded.
 *
 *  - DEMUX-DROP OBSERVABILITY (WI-5136): a home-grained row tagged with a slug
 *    OTHER than the bound home previously vanished in the projection's own
 *    `harness_slug` guard with no counter — count it into
 *    `federation_refused_op_counters` ('demux-mismatch') before delegating (the
 *    projection's guard still performs the actual drop). Fail-soft by the
 *    counter's own contract.
 */
function withHiveHomeApplyGuard<Row>(
  p: TableProjection<Row>,
  guard: {
    workspaceId: string;
    boundSlug: string;
    /**
     * EI-18771324701216281: OPTIONAL. Absent on a JOINER, where the home is remote and
     * never locally booted — the exclusion has nothing to exclude. It must not gate the
     * counter (see the DEMUX-DROP OBSERVABILITY duty above), which is the whole reason
     * this parameter became optional.
     */
    resolveHomeLogKeyHex?: () => string | null;
    sql?: import('postgres').Sql;
  },
): TableProjection<Row> {
  const rowSlug = (row: unknown): string | undefined => {
    if (!row || typeof row !== 'object') return undefined;
    const r = row as Record<string, unknown>;
    const v = r.harness_slug ?? r.pot_home_slug;
    return typeof v === 'string' ? v : undefined;
  };
  return {
    ...p,
    writeToPg: async (row, provenance) => {
      const homeLog = guard.resolveHomeLogKeyHex?.() ?? null;
      if (homeLog && provenance.sourceLogKeyHex === homeLog) {
        // home fold owns home-log ops. EI-19304844689981989: count it — this was
        // the last fully-silent drop in the guard (its demux sibling below always
        // bumped a counter), which made a "published + drained, never applied"
        // federation gap undiagnosable from the receiver side.
        await bumpFederationRefusedOp(
          {
            workspaceId: guard.workspaceId,
            harnessSlug: guard.boundSlug,
            sourceHive: provenance.sourceLogKeyHex ?? provenance.authorPubkey,
            tableTag: p.tableTag,
            reason: 'home-log-excluded',
          },
          guard.sql,
        );
        return;
      }
      const slug = rowSlug(row);
      if (slug !== undefined && slug !== guard.boundSlug) {
        await bumpFederationRefusedOp(
          {
            workspaceId: guard.workspaceId,
            harnessSlug: guard.boundSlug,
            sourceHive: provenance.sourceLogKeyHex ?? provenance.authorPubkey,
            tableTag: p.tableTag,
            reason: 'demux-mismatch',
          },
          guard.sql,
        );
      }
      return p.writeToPg(row, provenance);
    },
    deleteFromPg: async (key, delTs, delHlc, provenance) => {
      const homeLog = guard.resolveHomeLogKeyHex?.() ?? null;
      if (homeLog && provenance?.sourceLogKeyHex === homeLog) {
        // home fold owns home-log ops — counted for the same reason as the write
        // path above (EI-19304844689981989).
        await bumpFederationRefusedOp(
          {
            workspaceId: guard.workspaceId,
            harnessSlug: guard.boundSlug,
            sourceHive: provenance?.sourceLogKeyHex ?? provenance?.authorPubkey,
            tableTag: p.tableTag,
            reason: 'home-log-excluded',
          },
          guard.sql,
        );
        return;
      }
      return p.deleteFromPg(key, delTs, delHlc, provenance);
    },
  };
}

/**
 * Build this harness's projections as a fresh array. Single source of truth
 * for the per-harness projection SET — both the global-registry registration
 * (`registerAllHarnessProjections`) and the per-harness scoped apply
 * (`buildHarnessProjectionApply`) derive from it, so they never drift.
 */
export function buildHarnessProjections(opts: RegisterAllOpts): TableProjection<unknown>[] {
  // A-003: the hive-home-grained projections scope to the HIVE-HOME slug when
  // boot supplies one (a joiner's member harness, or — WI-3734 — an owned hive's
  // member harness), else to this harness's own slug (the home harness itself, or
  // today's non-rebind default). Every OTHER projection always stays on
  // `harnessSlug` — the rebind is surgical to the hive-home-grained set.
  const hiveScoped: RegisterAllOpts =
    opts.potHomeSlug && opts.potHomeSlug !== opts.harnessSlug
      ? { ...opts, harnessSlug: opts.potHomeSlug }
      : opts;
  // WI-3734: when boot threads the owned-home resolver, every hiveScoped projection
  // gets the home-log-exclusion + demux-drop-counting apply guard.
  //
  // EI-18771324701216281: the wrap USED to be gated on `opts.resolveHomeLogKeyHex` alone,
  // which made the demux-drop counter UNREACHABLE on joiners — the exact population the
  // demux bug afflicts. boot.ts only sets that resolver for `memberHomeRebindSlug`, and
  // that block returns undefined when `remote_hive === true`, i.e. for every joiner. So on
  // a joiner `hh()` was the identity function and `federation_refused_op_counters` could
  // never bump: WI-5136's counter read EMPTY, and that emptiness read as HEALTH. It cost
  // real diagnosis time on WI-559, where a zero drop-count was nearly taken as evidence the
  // fold was fine while ~49,762 ops were in fact being discarded.
  //
  // The guard's two duties are INDEPENDENT and are now gated independently:
  //   - HOME-LOG EXCLUSION needs the resolver; without it `homeLog` is null and nothing is
  //     excluded — which is already the correct, intended behavior for a joiner (the home
  //     is remote and never locally booted, so there is nothing to exclude).
  //   - DEMUX-DROP OBSERVABILITY needs only a bound hive-home slug to compare rows against.
  // Wrapping therefore keys on EITHER signal. Apply behavior is unchanged in the newly
  // covered case (no resolver ⇒ no exclusion; the projection's own `harness_slug` guard
  // still performs the actual drop) — the only difference is that the drop is now COUNTED.
  //
  // Kept surgical to the hive-home-BOUND set (`potHomeSlug` set and ≠ own slug). A harness
  // that is its own home is deliberately left unwrapped: identity, exactly as before.
  const hiveHomeBound = Boolean(opts.potHomeSlug && opts.potHomeSlug !== opts.harnessSlug);
  const hh = <Row,>(p: TableProjection<Row>): TableProjection<Row> =>
    opts.resolveHomeLogKeyHex || hiveHomeBound
      ? withHiveHomeApplyGuard(p, {
          workspaceId: opts.workspaceId,
          boundSlug: hiveScoped.harnessSlug,
          ...(opts.resolveHomeLogKeyHex
            ? { resolveHomeLogKeyHex: opts.resolveHomeLogKeyHex }
            : {}),
          sql: opts.sql,
        })
      : p;
  // WI-2105 REV (no-hiveHome fix): the member-content GUARD's hive-home is resolved for
  // a BROADER set than the projection rebind — any hive-peered harness incl. an OWNED
  // hive's member harness (`memberContentHiveHome`). Override ONLY `potHomeSlug` (which
  // the content projections read for the guard's member-set lookup); `harnessSlug` stays
  // the member slug (writes still land under it) and `hiveScoped` is untouched here.
  // (WI-3734: the owned-hive member NOW rebinds the hive-home projections too — via
  // boot's `potHomeSlug` + the `resolveHomeLogKeyHex` home-log exclusion above, which
  // closes the double-apply this decoupling originally existed to avoid.)
  const guardScoped: RegisterAllOpts =
    opts.memberContentHiveHome && opts.memberContentHiveHome !== opts.potHomeSlug
      ? { ...opts, potHomeSlug: opts.memberContentHiveHome }
      : opts;
  return [
    buildContributorsProjection(opts),
    // WI-259 (MEMBERSHIP-AWARE — plan shared-hive-member-content-federation-2026-06-20;
    // supersedes the reverted "Option B" hive-home remap): a shared-hive MEMBER's
    // feature/plan/issue content stays under its OWN member slug (`opts`), NOT a re-keyed
    // hive-home slug — member slugs aren't peer-stable, and re-keying needed an unforgeable
    // origin discriminator we lack (author_pubkey is caller-supplied / spoofable). Instead
    // these 6 content projections keep member-slug scope, and each writeToPg's guard is
    // upgraded from the bare `harness_slug !== ownSlug` drop to a membership-aware check
    // (`shouldApplyMemberContentOp`): a cross-member op applies iff its VERIFIED source-log
    // device — `resolveAuthorDevice(op.sourceLogKeyHex)` (threaded via opts) — is in the
    // CURRENT hive member set. So a peer member's content federates + stays attributable
    // under its author's slug, and a removed member's writes stop applying, with no re-key.
    buildFeatureClaimsProjection(guardScoped),
    buildFeatureQueueProjection(guardScoped),
    buildFeatureWorkingSetProjection(guardScoped),
    buildHarnessFeaturesProjection(guardScoped),
    buildHarnessPlansProjection(guardScoped),
    buildIssuesProjection(guardScoped),
    buildPresenceProjection(opts),
    buildUsageProjection(opts),
    buildCoordConversationProjection(guardScoped),
    buildCoordMessageProjection(guardScoped),
    buildCoordThreadProjection(guardScoped),
    buildCoordThreadPostProjection(guardScoped),
    buildPlanItemAssignmentsProjection(guardScoped),
    // A-003: hive_settings + hive_members demux on the hive-HOME slug — scope them
    // to `hiveScoped` so a joiner's member harness lands the home-grained ops.
    hh(buildHiveSettingsProjection(hiveScoped)),
    // F1-1 (federated-scout-gym): SHAREABLE standing facts, hive-home-grained
    // like hive_settings (the fact's harness_slug carries the hive home slug).
    hh(buildAgentFactsProjection(hiveScoped)),
    // mem0-cross-machine-federation-2026-07-10 (F1-1 mirror): SHAREABLE memories,
    // hive-home-grained like hive_settings (the memory's harness_slug carries the hive home slug).
    hh(
      buildMemoriesProjection({
        ...hiveScoped,
        ...(opts.memoryFederationFlagOn
          ? { isFlagOn: opts.memoryFederationFlagOn }
          : {}),
      }),
    ),
    // F1-2/F1-5 (federated-scout-gym): foreign QD elites, hive-home-grained too
    // (the elite's harness_slug carries the hive home slug — mig 465 demux).
    // F1-6/P-014: thread the WI-259 verified-source-log→device resolver as
    // `resolveSignerDevice` so the receive-side elite-outcome gate
    // (verifyEliteOutcomeForElite) can bind a signed EliteOutcomeRecord to the
    // relaying device (anti-lift). `resolveAuthorDevice` maps sourceLogKeyHex →
    // devicePubkey via `admittedIdentities`, which holds ONLY admitted-member
    // devices — so a non-null result already proves membership and the separate
    // isDeviceAdmitted seam is unnecessary here.
    hh(buildGymQdElitesProjection({ ...hiveScoped, resolveSignerDevice: hiveScoped.resolveAuthorDevice })),
    hh(buildBeeClaimSpecProjection(hiveScoped)),
    // P-044 DG-1: verdict facts are hive-home-grained (the gate is a hive-wide
    // aggregate) — scope like hive_settings so a joiner receives + verifies them.
    hh(buildGateVerdictProjection(hiveScoped)),
    hh(buildHiveMembersProjection(hiveScoped)),
    // EN-1: hive_policy is hive-home-grained too (the owner-signed policy demuxes on
    // the Hive home) — scope it to `hiveScoped` so a joiner receives + verifies it.
    hh(buildHivePolicyProjection(hiveScoped)),
    // EN-3: hive_reports (member→owner moderation queue) + hive_pending_joins (approval-mode
    // admission queue) are hive-home-grained too — scope to `hiveScoped` so the bidirectional
    // request↔decision federation lands on both the owner's home and a joiner's member harness.
    hh(buildHiveReportsProjection(hiveScoped)),
    hh(buildHivePendingJoinsProjection(hiveScoped)),
    // shared-hive-rekey-2026-06-19 (P-005): hive_epoch_keys (per-member wrapped epoch keys
    // for the read-plane re-key) is hive-home-grained too — scope to `hiveScoped` so a
    // joiner's member harness lands the owner's epoch-key rows. DARK: the boundary trigger +
    // producer are flag-gated (papercusp-hive-rekey), so the table stays empty until cutover.
    hh(buildHiveEpochKeysProjection(hiveScoped)),
    buildEngineerIssuesProjection(guardScoped),
    // plan-federation-regrain-2026-06-13 P-006: per-PART plan federation (tableTag
    // 'plan-parts'). Additive + DARK — receives nothing until papercusp-plan-part-federation
    // is on (capture is flag-gated) and its harness_plans recompose is itself flag-gated.
    buildHarnessPlanPartsProjection(guardScoped),
    // p2p-work-distribution-2026-07-02 P-001: P2P capability grants are hive-home-
    // grained (a grant/revocation must land on every member machine, M19) — scope
    // like hive_settings. The projection RECEIVER-ENFORCES the op author's attested
    // identity == the row's grantor (M6/L9) before applying. Inert until grants are
    // authored (zero/empty by default — the P-005 structural-inertness pattern).
    hh(buildP2pPeerGrantsProjection(hiveScoped)),
    // P-004: receipts are hive-home-grained like grants (the requester's machines
    // must receive them) — scope to hiveScoped.
    hh(buildP2pReceiptsProjection(hiveScoped)),
    // P-101 (D-006): the fleet directory is hive-home-grained like hive_policy (the
    // record demuxes on the Hive home + its verify resolves attestations there) —
    // scope to hiveScoped so a joiner receives + verifies directory records.
    hh(buildFleetDirectoryProjection(hiveScoped)),
    // P-102 store leg (WI-1935): offers are hive-home-grained like the directory
    // (the fleet owner's machines must receive them; verify resolves attestations
    // on the Hive home) — scope to hiveScoped.
    hh(buildWorkOffersProjection(hiveScoped)),
    // P-302 LIVE-2 seam 1: leader leases are hive-home-grained liveness hints
    // (not auth records) and share the same home-scope as the fleet directory.
    hh(buildFleetLeaderLeaseProjection(hiveScoped)),
  ] as TableProjection<unknown>[];
}

export function registerAllHarnessProjections(opts: RegisterAllOpts): void {
  if (!opts.workspaceId) throw new Error('registerAllHarnessProjections: workspaceId required');
  if (!opts.harnessSlug) throw new Error('registerAllHarnessProjections: harnessSlug required');
  for (const p of buildHarnessProjections(opts)) registerProjection(p);
}

/**
 * Build a PER-HARNESS scoped op-apply bound to THIS harness's own projection
 * set — the fix for the global-registry collision (Model B D-021). The global
 * `registry` is keyed by `tableTag`, so two booted harnesses registering the
 * same tag overwrite each other and `applyHyperbeeOpToPg` dispatches to whoever
 * registered LAST → the other harness's ops are silently dropped by the
 * projections' own `harness_slug` guard. Boot wires its `mergeNow` to call THIS
 * scoped apply instead, so each harness applies its own ops to its own
 * projections with no cross-harness interference.
 *
 * The returned `apply` reuses the shared `applyOpVia` dispatch core (the same
 * put/del/decode/clobber logic the global path uses) with a lookup bound to a
 * private per-harness `Map<tableTag, projection>`.
 */
export function buildHarnessProjectionApply(opts: RegisterAllOpts): HarnessProjectionApply {
  if (!opts.workspaceId) throw new Error('buildHarnessProjectionApply: workspaceId required');
  if (!opts.harnessSlug) throw new Error('buildHarnessProjectionApply: harnessSlug required');
  const scoped = new Map<string, TableProjection<unknown>>();
  for (const p of buildHarnessProjections(opts)) scoped.set(p.tableTag, p);
  const lookup: ProjectionLookup = (tableTag) => scoped.get(tableTag) ?? null;
  // G1 Provenance (P-002): thread ownLogKeyHex so the apply path can determine
  // origin via log-source (own log → 'local', admitted remote log → 'remote').
  const applyOpts: ApplyOpOpts = opts.ownLogKeyHex ? { ownLogKeyHex: opts.ownLogKeyHex } : {};
  const apply = (op: OpEnvelope) => applyOpVia(lookup, op, applyOpts);
  // p2p-join-catchup-speed-2026-09-23 P-002: the SAME projection instances answer the
  // merge's stored-order prefetch (and P-528's supersedable-put check), so a rekey
  // rebuild swaps them together.
  return Object.assign(apply, {
    prefetchStoredOrder: buildStoredOrderPrefetch(lookup),
    supersedablePut: buildSupersedablePut(lookup),
  });
}

/** The scoped apply plus the merge look-ahead hooks bound to the same projection set. */
export type HarnessProjectionApply = ((op: OpEnvelope) => Promise<boolean>) & {
  prefetchStoredOrder: StoredOrderPrefetch;
  supersedablePut: SupersedablePut;
};
