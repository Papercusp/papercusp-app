/**
 * WI-10004651: the ACKNOWLEDGED content-drift set — applied migrations whose bytes on
 * disk are already known to differ from the sha256 recorded when they ran.
 *
 * `checkMigrationDrift` has measured content drift since EI-19365742982915607, but
 * only `db:check_drift` ever read it, and on a long-lived dev database the list is
 * never empty (102 entries at the 2026-10-01 freeze, most of them years-old comment
 * edits or squashed history). A list that is never empty cannot alert on its own, so
 * NEW drift accrued in silence: 1044, 1154 and 1219 joined it unnoticed, and 1219
 * left the live `stamp_acceptance_bar_epoch` trigger without its run-instance
 * exemption until a deployed smoke tripped over it (repaired by migration 1288).
 *
 * This set is what makes the signal quiet enough to alert on. `contentDriftNew` in
 * migration-drift.ts is every hazardous drift entry NOT listed here, and the
 * improvements watchdog files a bug for each one.
 *
 * GROWING this set is an acknowledgement, never a silencer: add an entry only once
 * the drift is resolved (a repair migration re-applied the intended state) or proven
 * benign (comment-only), and say which in the reason. Every reason must be non-empty
 * (migration-content-drift-acknowledged.test.ts). Never add an entry just to make the
 * watchdog stop filing — that re-creates the silent accrual this exists to end.
 *
 * Generated from a live measurement, not a hand-run grep:
 * `checkMigrationDrift({ classifyContent: true })` against the dev database on
 * 2026-10-01 (sql dir: the canonical staging tree). The classification in each reason
 * is the verdict at the freeze; `unclassified` there mostly means the 20s classify
 * budget ran out, not that the edit is hazardous.
 */

const FROZEN = {
  executable: 'frozen 2026-10-01 (executable at freeze)',
  commentsOnly: 'frozen 2026-10-01 (comments-only at freeze)',
  unclassified: 'frozen 2026-10-01 (unclassified at freeze)',
} as const;
const F = FROZEN;

/** filename → why its content drift is acknowledged. */
export const ACKNOWLEDGED_CONTENT_DRIFT: ReadonlyMap<string, string> = new Map<string, string>([
  ['1044-completion-identity-multi-repo-artifact-floor.sql', F.executable],
  ['110-harness-gym-control-plane.sql', F.commentsOnly],
  ['1154-prose-embedding-profile-identity.sql', F.executable],
  ['1219-blueprint-operation-invocations.sql', 'repaired by 1288-restore-run-instance-bar-epoch-exemption.sql (WI-10004651)'],
  ['132-coordination-conversations.sql', F.executable],
  ['151-operator-curation.sql', F.executable],
  ['159-work-items-union-view.sql', F.executable],
  ['181-hyperbee-projection-fed-ts-guard.sql', F.executable],
  ['208-scout-ticks-and-lens-weights.sql', F.executable],
  ['225-fleet-assignment-nursery-alias-liveness.sql', F.executable],
  ['231-cross-hive-asks.sql', F.executable],
  ['259-autonomy-policy.sql', F.executable],
  ['270-harness-plan-parts.sql', F.executable],
  ['271-harness-plan-parts-capture.sql', F.executable],
  ['275-coord-event-log-sync-invalidate.sql', F.executable],
  ['282-drop-harness-summaries-mirror.sql', F.unclassified],
  ['283-drop-harness-branch-actions-mirror.sql', F.unclassified],
  ['303-plan-runs-workspace-isolation.sql', F.executable],
  ['313-memory-archived-state.sql', F.unclassified],
  ['314-d001-hlc-ordering-key.sql', F.commentsOnly],
  ['316-hive-epoch-keys.sql', F.commentsOnly],
  ['327-seed-hive-coordination-health-rubric.sql', F.executable],
  ['338-migrate-hive-coordination-health-rubric-to-plan.sql', F.executable],
  ['353-drop-v1-rubrics-table.sql', F.commentsOnly],
  ['355-coord-open-escalations-projection.sql', F.executable],
  ['361-coord-plane-workspace-restamp.sql', F.executable],
  ['363-commit-attribution-ledger.sql', F.commentsOnly],
  ['378-code-recipes-global.sql', F.executable],
  ['389-bee-claim-spec-id-only.sql', F.executable],
  ['396-coord-links-change-notify.sql', F.executable],
  ['408-routines-ephemeral-tier.sql', F.commentsOnly],
  ['412-tool-utilization-code-run-adoption.sql', F.executable],
  ['423-d001-restore-work-items-op-hlc.sql', F.commentsOnly],
  ['430-fleet-membership-append-only-fact.sql', F.executable],
  ['501-session-turns.sql', F.executable],
  ['507-emit-change-notify-natural-key.sql', F.executable],
  ['517-fix-stamp-local-federated-write-mask.sql', F.executable],
  ['525-fleet-assignment-work-items-notify.sql', F.executable],
  ['526-add-integration-credentials.sql', F.executable],
  ['531-rename-hive-coordination-health-rubric-to-pot.sql', F.executable],
  ['554-cup-lexicon-db-rename-phase1.sql', F.executable],
  ['555-cup-lexicon-db-rename-phase2-bee-claim-specs-beekeeper.sql', F.executable],
  ['557-cup-lexicon-db-rename-phase3.sql', F.unclassified],
  ['560-fix-capture-engineer-issues-outbox-pots-rename.sql', F.unclassified],
  ['561-coord-conditions-partial-index.sql', F.unclassified],
  ['564-memory-federation-columns.sql', F.unclassified],
  ['589-releases-registry.sql', F.unclassified],
  ['603-backup-safe-cadence.sql', F.unclassified],
  ['617-routines-grouping.sql', F.unclassified],
  ['626-pot-scoped-resource-allotments.sql', F.unclassified],
  ['631-reslug-operator-workspace-changetask-to-papercusp.sql', F.unclassified],
  ['640-unify-workitem-readiness-triggers.sql', F.unclassified],
  ['642-unify-claim-spec-states-todo-to-open.sql', F.unclassified],
  ['645-outbox-quarantine-persist.sql', F.unclassified],
  ['649-pot-membership-backfill.sql', F.unclassified],
  ['651-pot-membership-enforce-trigger.sql', F.unclassified],
  ['654-work-item-claim-floors-ssot.sql', F.unclassified],
  ['655-engineer-issues-claim-race-guard.sql', F.unclassified],
  ['656-canonicalize-plan-harness-slug.sql', F.unclassified],
  ['657-restore-wi5720-deleted-plan-rows.sql', F.unclassified],
  ['660-boot-history-events.sql', F.unclassified],
  ['665-bash-tool-substitutions.sql', F.unclassified],
  ['685-substrate-merge-cursor-apply-binding.sql', F.unclassified],
  ['689-agent-facts-append-versioning.sql', F.unclassified],
  ['690-agent-facts-depends-on-kind-claim.sql', F.unclassified],
  ['694-tool-invocations-agent-state-stamp.sql', F.unclassified],
  ['695-boot-history-events-origin-column.sql', F.unclassified],
  ['696-task-ledger.sql', F.unclassified],
  ['707-adv-sessions-first-seen-at.sql', F.unclassified],
  ['708-federate-work-item-authority.sql', F.unclassified],
  ['713-fleet-invariants.sql', F.unclassified],
  ['723-p2p-receipts-honored-kind.sql', F.unclassified],
  ['727-widen-prose-embedding-cols-to-gemma-native-768.sql', F.unclassified],
  ['730-agent-facts-undecidable-kind.sql', F.unclassified],
  ['734-repoint-qualified-refs-on-rehome.sql', F.unclassified],
  ['750-drop-dead-hfc-partial-indexes.sql', F.unclassified],
  ['751-drop-redundant-tool-usage-rollup-verb-idx.sql', F.unclassified],
  ['752-drop-redundant-memory-recall-stats-pools-idx.sql', F.unclassified],
  ['754-drop-three-dead-partial-indexes.sql', F.unclassified],
  ['755-drop-memory-canonical-current-idx.sql', F.unclassified],
  ['757-memory-canonical-row-kind-discriminator.sql', F.unclassified],
  ['793-backfill-observation-lane-residue.sql', F.unclassified],
  ['796-conversation-supersession.sql', F.unclassified],
  ['804-fix-terminal-close-staging-remedy.sql', F.unclassified],
  ['806-work-item-worked-history.sql', F.unclassified],
  ['815-expose-claim-spec-fields-on-engineer-issues-view.sql', F.unclassified],
  ['823-retire-p2p-work-intake.sql', F.unclassified],
  ['829-harness-qualify-engineer-issue-op-identity.sql', F.unclassified],
  ['832-plan-audits.sql', F.unclassified],
  ['850-test-runs-future-timestamp-clamp.sql', F.unclassified],
  ['851-first-class-plan-spec-clauses.sql', F.unclassified],
  ['864-migrate-legacy-human-parks-to-agent-review.sql', F.unclassified],
  ['867-repair-post-864-legacy-human-park-recurrence.sql', F.unclassified],
  ['870-retire-post-868-legacy-human-park-recurrence.sql', F.unclassified],
  ['888-google-calendar-poll-routine.sql', F.unclassified],
  ['889-owned-trigger-source-uniqueness.sql', F.unclassified],
  ['948-design-compare-artifact-kinds.sql', F.unclassified],
  ['950-retire-post-870-legacy-needs-human-recurrence-wave2.sql', F.unclassified],
  ['959-owned-trigger-source-account-identity.sql', F.unclassified],
  ['972-completion-authority-content-identity-floor.sql', F.unclassified],
  ['978-hosted-customer-rls.sql', 'repaired by 1370-hosted-customer-rls-role-lock.sql (EI-25183160168061907; replayed the role reconciliation with catalog serialization)'],
  ['992-work-item-dependency-satisfaction.sql', F.unclassified],
  ['996-work-item-completion-settlement-readiness.sql', F.unclassified],
]);

/**
 * The hazardous drift entries that are NOT acknowledged: anything not proven
 * comment-only (`executable` or `unclassified` — unclassified fails toward
 * reporting, the same rule as `contentDriftExecutable`) whose filename is absent
 * from {@link ACKNOWLEDGED_CONTENT_DRIFT}. Pure; the acknowledged set is injectable
 * so tests do not depend on the frozen data.
 */
export function selectNewContentDrift<T extends { filename: string; classification: string }>(
  drift: readonly T[],
  acknowledged: ReadonlyMap<string, string> = ACKNOWLEDGED_CONTENT_DRIFT,
): T[] {
  return drift.filter((d) => d.classification !== 'comments-only' && !acknowledged.has(d.filename));
}
