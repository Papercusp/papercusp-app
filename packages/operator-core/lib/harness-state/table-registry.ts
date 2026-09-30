/**
 * Harness-state table registry — the single source of truth for the two-axis
 * storage model (plan `harness-state-storage-unification-2026-06-01`, P-002).
 *
 * Spec: `/internal/docs/system/storage-policy` § "Two axes". Vocabulary is
 * deliberate — DO NOT write "canonical"; use these two orthogonal axes:
 *
 *   • key  — the runtime store-of-record identity (always PG; D-002):
 *       'slug-shared'     → keyed by harness_slug; ONE set shared across every
 *                            workspace that has the harness in its registry
 *                            (harnesses-across-workspaces D-1: shared results).
 *       'workspace-owned' → keyed by (workspace, harness, …); per-workspace
 *                            config / settings / personal state (D-1).
 *
 *   • sync — the cross-machine SYNC AUTHORITY (merge + propagation):
 *       'none'     → local-only; never leaves this install.
 *       'git'      → committed `.papercusp/state/` files, GitHub-merged
 *                    (dogfood D-001/D-020 — git over Hyperbee for documents).
 *       'peer-log' → Hyperbee/Model-B per-peer log, LWW (live shared state).
 *
 * PG is the runtime store-of-record for EVERY row regardless of `sync`; the
 * sync authority is the cross-machine merge point that PG converges to. `git`
 * and `peer-log` tables are hydrated-from / exported-to their authority; PG is
 * never a "disposable cache" (see the storage-policy reframe).
 *
 * STATUS: P-002 classification COMPLETE — every previously-ambiguous table now
 * has an explicit call (NEEDS_REVIEW is empty). The DEFAULT covers the large
 * majority (per-install, slug-keyed result tables that don't sync); only the
 * EXCEPTIONS are declared. Live-schema-drift coverage (a NEW table added later
 * must be classified, not silently DEFAULTed) is asserted by the P-003
 * projection engine at boot via `classifyInventory()` against the live schema.
 */

export type TableKey = 'slug-shared' | 'workspace-owned';
export type SyncAuthority = 'none' | 'git' | 'peer-log';

export interface TableSpec {
  /** runtime store-of-record identity (PG is always the store). */
  key: TableKey;
  /** cross-machine merge + propagation authority. */
  sync: SyncAuthority;
  /** never cross machines under any circumstance (§7.5 SECURITY); forces sync='none'. */
  security?: boolean;
  /** legacy/dead surface (kept for reference; not extended) — D-008 papercup-org. */
  legacy?: boolean;
  /** why this differs from DEFAULT / where it came from. */
  note?: string;
}

/** Fall-through for the large majority: a per-install, slug-keyed result table. */
export const DEFAULT_SPEC: TableSpec = { key: 'slug-shared', sync: 'none' };

/**
 * GIT sync authority — document-shaped shared state (dogfood §7.2 GIT bucket).
 * key=slug-shared; PG hydrates from / exports to `.papercusp/state/<…>`.
 */
const GIT_DOCS = [
  // NB: `harness_summaries` was here but is REMOVED (fs-watcher-retirement step 2,
  // migration 280). It mirrored the top-level `.papercusp/summary.md`, a dead
  // legacy path: nothing wrote the file and nothing read the table (the live
  // summary UI is served from harness_text_artifacts, migration 035). The table
  // is dropped; detachStaleGitCaptureTriggers cleans up its capture trigger on boot.
  // NB: `harness_escalations` was here but is REMOVED (WI-10003731) — see
  // RETIRED_HOST_LOCAL_GIT_TABLES below for why and what cleans up after it.
  'harness_decisions',
  'harness_design_artifacts', 'harness_text_artifacts', 'harness_chunk_plans',
  'harness_feature_notes', 'harness_feature_debug_notes', 'feature_audit_consolidated',
  'harness_tests',
  // NB: llm_test_fixtures / llm_test_claims / llm_test_findings are NOT git docs.
  // They carry neither `harness_slug` nor `workspace_id` (they're GLOBAL operator
  // evaluation state, keyed by scenario/run — not per-harness), so the harness-keyed
  // git_export_outbox capture (`harness_slug` NOT NULL) crashed every insert
  // ("null value in column harness_slug" → persistRunReport failed → a fresh
  // llm-test run couldn't persist). They are operator runtime state → sync:'none'
  // (PG store-of-record, no git sync authority). Re-add only behind a workspace/
  // global git-export path that doesn't require harness_slug.
  // harness_phases removed — fs-watcher-retirement step 5 (migration 285): a
  // local fs-watcher mirror with hardcoded alive=false; not a git document.
  'harness_promotions', 'harness_checkpoints',
  'harness_snapshots',
  'harness_skills', 'harness_proposals_shared', 'snapshot_features',
  // NB: `goals` and `project_spec_revisions` were here — REMOVED (EI-10521), the
  // SAME defect as the llm_test_* tables above and for the same reason. Neither
  // carries `harness_slug`: a goal is INSTALL-scoped (`install_slug`) and a spec
  // revision is PROJECT-scoped (`project_id`). The harness-keyed git_export_outbox
  // capture reads `row->>'harness_slug'` into a NOT NULL column, so every INSERT
  // into either table raised "null value in column harness_slug" and the trigger
  // ABORTED the caller's write — goal creation (goal-lineage.ts) and the project
  // spec-revision route both failed 100% of the time, which is why both tables held
  // ZERO rows. They are not harness documents (there is no per-harness
  // `.papercusp/state/` dir to export them into) → they fall to DEFAULT (sync:'none',
  // PG store-of-record). detachStaleGitCaptureTriggers drops their live triggers on
  // the next boot. Re-add ONLY behind a workspace/install-scoped git-export path that
  // does not require harness_slug.
];

/**
 * NOT git-synced even though once classified as such (P-003b live-boot lesson):
 *   • `harness_branch_actions` — a LOCAL fs-watcher projection (Mirror 7k: the
 *     repo's `git log` enrichment) whose `last_check_ms` heartbeat is re-upserted
 *     on EVERY poll regardless of content. Git-exporting it produced a perpetual
 *     drain loop (a file rewritten every ~20s with only a timestamp diff). It's
 *     recomputed locally from git-tracked files, so PG is a derived cache, not a
 *     document — it falls to DEFAULT (slug-shared / sync:none).
 *   • `harness_lanes` — the LIVE agent-lane occupancy tracker (`pid`, `started_at`
 *     of the OS process currently in each phase/role lane). PIDs are machine-local
 *     ephemeral runtime ids — meaningless to git-sync across machines. Like
 *     branch_actions it churned (re-upserted per heartbeat) and, for ephemeral
 *     gym-smoke test harnesses with no drain loop, accumulated 600+ stuck-unexported
 *     outbox rows. It's operational runtime state, not a document → DEFAULT.
 *   • `messages` / `directives` / `briefings` / `directive_summaries` — the
 *     RETIRED papercup-org demo bus (003-papercusp-shared.sql, D-008 family). They
 *     live in the `papercusp_shared` schema with NO workspace_id/harness_slug/origin,
 *     so they cannot fit the per-harness git-export model (keyed by harness root) —
 *     the engine only attaches to `harness_shared.*` and silently skipped them. The
 *     bare names also collide with the REAL inter-agent bus (`harness_<slug>.messages`,
 *     from_slug/to_slug), which was likewise never git-exported (per-harness schema,
 *     never attached). P-004 consolidated that real bus + supervisor_notes /
 *     directive_summaries / executed_actions into harness_shared.*_consolidated
 *     (migrations 119/120); they resolve to DEFAULT (slug-shared / sync:'none' —
 *     local, never synced), matching their pre-consolidation behavior. config_token
 *     was retired entirely (token_index is the authoritative workspace-owned token
 *     store; migration 121).
 *     Net: removing them makes the registry match reality (they were never synced).
 * Rule: NEVER sync:'git' — (a) fs-watcher *mirrors* (projections of already-git-
 * tracked files), (b) operational/runtime state (volatile columns: pid, started_at,
 * last_check_ms, alive, port — anything machine-local or heartbeat-bumped), and
 * (c) the retired org-demo schema. Only producer-authored harness_shared DOCUMENT
 * tables (decisions, summaries, notes, tests, plans, …) are the git set. A
 * volatile column makes a row "change" every write, so the no-op capture guard
 * can't save it — the table must simply not be git-synced.
 */

/**
 * PEER-LOG sync authority — live cross-machine shared state (§7.1 HYPERBEE +
 * the Hyperbee/Model-B projection set in apps/operator/lib/sync/hyperbee/projections).
 */
const PEER_LOG_LIVE = [
  'harness_features_consolidated', 'harness_issues_consolidated',
  'feature_claims', 'feature_queue', 'feature_working_set',
  'contributors', 'contributor_usage_events',
  'shared_presence',
  // NB: `harness_feature_prs` was here (a Phase-5a aspiration to move PR state
  // onto the peer-log) but is REMOVED — falls through to DEFAULT (slug-shared /
  // sync:'none'). NO peer ever produced `prs` ops (no CDC trigger, no log-first
  // append; the poll daemon was never built), so the read projection never fired
  // and the classification was purely aspirational. PR state is GitHub-derived +
  // re-polled per-machine (GitHub is the PR authority of record), so federation
  // is redundant: PG is the local store-of-record, never synced. The orphan
  // `prs` projection + Hyperbee key shape were retired alongside this (EI-479).
];

/**
 * PEER-LOG sync authority BUT workspace-owned key — the one combination the
 * slug-shared PEER_LOG_LIVE set above can't express. Plans are keyed by
 * (workspace_id, harness_slug, plan_slug) — per-workspace, not one-set-across-
 * workspaces — yet they federate cross-machine over the same peer-log machinery
 * as papercup-harness content (plans-pg-canonical-migration-2026-06-03 D-004/D-008).
 * Federation rides the harness swarm; the shared workspace_id is consistent
 * across the Model-B peers that share that workspace+harness.
 */
const PEER_LOG_WORKSPACE_OWNED = [
  'harness_plans',
  // distributed-coordination-shared-harness-2026-06-04 (Track A): a HARNESS-SCOPED
  // conversation federates as harness content over the peer-log. Keyed by
  // (workspace_id, id); the harness swarm carries the harness-scoped rows
  // (operator-scope conversations stay LOCAL — the capture trigger filters
  // scope='harness'). Listed here so it resolves to sync:'peer-log' BEFORE the
  // `coord_` prefix rule would classify it sync:'none'.
  'coord_conversations',
  // distributed-coordination-shared-harness-2026-06-04 (Track A, surface #1):
  // harness-scoped coord_event_log content (messages/handoffs/escalations)
  // federates over the peer-log. Keyed by (workspace_id, msg_id); only rows with
  // harness_slug set + non-fanout (the capture trigger filters) cross. Listed
  // here so it resolves to sync:'peer-log' BEFORE the `coord_` prefix rule.
  'coord_event_log',
  // distributed-coordination-shared-harness-2026-06-04 (Track A): a harness-scoped
  // conversation's reply timeline — the thread header + its posts — federates.
  // coord_threads keyed by (workspace_id, thread_id); coord_thread_posts by
  // (workspace_id, post_msg_id) (the bigserial id is machine-local).
  'coord_threads',
  'coord_thread_posts',
  // plan-item-assignment-claim-liveness-2026-06-04 (D-002): per-plan-item ASSIGNMENT
  // is durable, low-churn, shared-knowledge → federates as content over the peer-log
  // (LWW on the small per-item record). Keyed (workspace_id, harness_slug, plan_slug,
  // item_id), folded to the generated fed_key for capture. The leased CLAIM
  // (plan_item_claims) is authority-mediated and is NOT here (never federated).
  'plan_item_assignments',
  // shared-hive-federation-2026-06-08 (P-005): per-Hive settings federate as Hive
  // state over the peer-log (projections/hive-settings.ts). Keyed (workspace_id,
  // harness_slug = the Hive home, setting_key) → workspace-owned + peer-log; rides
  // the Hive-pubkey topic (P-004).
  'pot_settings',
  // cross-machine-coord-parity-and-trust-2026-07-01 (P-016): the Queen's per-bee
  // claim SPECS federate as hive state (projections/bee-claim-spec.ts) so a remote
  // bee's get_next sees spec authoring/versioning. Keyed (workspace_id, bee_id);
  // harness_slug = the hive HOME slug demux (NULL = operator-scope, stays local —
  // the mig-438 WHEN gate).
  'cup_claim_specs',
  // cross-machine-coord-parity-and-trust-2026-07-01 (P-044 DG-1): the distributed
  // test gate's verdict facts (projections/gate-verdicts.ts) — content-addressed,
  // device-SIGNED shard-run results federated as data so the DG-5 aggregator on any
  // member machine assembles green(S) from every runner's verdicts. Keyed
  // (workspace_id, verdict_id); harness_slug = the hive HOME slug demux (NULL =
  // machine-local, stays local — the mig-442 WHEN gate). Immutable INSERT-only facts.
  'gate_verdicts',
  // shared-hive-federation-2026-06-08 (P-006): per-Hive contributor/device admission
  // (hive_members — the Hive-grain analog of contributors) federates across the Hive's
  // Swarms so a revocation propagates. Keyed (workspace_id, hive_home_slug,
  // github_user_id) → workspace-owned + peer-log.
  'pot_members',
  // shared-hive-owner-enforcement-2026-06-19 (EN-1): the owner-SIGNED Hive policy
  // record (projections/hive-policy.ts). SINGLETON per Hive — keyed (workspace_id,
  // harness_slug = the Hive home) → workspace-owned + peer-log; rides the Hive-pubkey
  // topic (P-004). The projection VERIFIES the owner signature before applying (a
  // forged policy is dropped). Listed here so it resolves to sync:'peer-log'.
  'pot_policy',
  // shared-hive-owner-enforcement-2026-06-19 (EN-3 / P-MEMBER): approval-mode pending
  // join requests (projections/hive-pending-joins.ts). Keyed (workspace_id, harness_slug
  // = the Hive home, github_user_id) → workspace-owned + peer-log; rides the Hive-pubkey
  // topic. Bidirectional on the hive-home seam: a joiner's REQUEST reaches the owner, the
  // owner's DECISION (status) reaches the joiner back.
  'pot_pending_joins',
  // shared-hive-owner-enforcement-2026-06-19 (EN-3 / P-MOD): the member→owner moderation
  // report queue (projections/hive-reports.ts). Keyed (workspace_id, harness_slug = the
  // Hive home, report_id) → workspace-owned + peer-log. A MEMBER's report federates to the
  // owner's queue; the owner's resolution (status) federates back. (Takedowns + bans ride
  // EN-1's owner-SIGNED pot_policy, not this table — reports go member→owner so they
  // cannot ride the owner signature.)
  'pot_reports',
  // shared-hive-rekey-2026-06-19 (P-005): per-member WRAPPED epoch keys for the read-plane
  // re-key (projections/hive-epoch-keys.ts). Keyed (workspace_id, harness_slug = the Hive
  // home, epoch, member_device_pubkey) → workspace-owned + peer-log; rides the Hive-pubkey
  // topic. DARK until papercusp-hive-rekey flips (the boundary trigger + producer are
  // flag-gated, so the table stays empty + its capture trigger never fires locally).
  'pot_epoch_keys',
  // fed-reanchor B5: the work-queue's issue/task family (work_items kind ∈ bug|change|
  // task) federates over the Hive peer-log — closes engineer-issues-2026-06-03 D-009's
  // "federation deferred". Keyed (workspace_id, issue_id); the capture trigger (mig 197)
  // derives the federation slug from `scope` ('harness:<slug>' → <slug>; 'operator' →
  // the Hive home) and stamps it as harness_slug for the projection demux. Listed here
  // so it resolves to sync:'peer-log' BEFORE the WORKSPACE_OWNED_EXPLICIT entry would.
  'engineer_issues',
  // plan-federation-regrain-2026-06-13 (P-005/P-006): per-PART plan federation —
  // each plan part (item/decision/section) federates as its own LWW key so
  // concurrent edits to DIFFERENT parts merge (D-009). Producer = the CDC capture
  // trigger (mig 271); projection 'plan-parts' (projections/harness-plan-parts.ts).
  // DARK until papercusp-plan-part-federation flips: nothing writes this table
  // locally until the flag-gated capture lands, so the trigger never fires.
  'harness_plan_parts',
  // p2p-work-distribution-2026-07-02 (P-001): P2P capability grants — a grantor
  // (numeric gh user-id, X9) grants a polymorphic {fleet|pool} grantee capabilities
  // over the grantor's machines. Keyed (workspace_id, harness_slug = the hive HOME,
  // grantor_github_user_id, grantee_kind, grantee_ref) → workspace-owned + peer-log;
  // M19: federates USER-level so a revocation lands on every machine. Producer =
  // CDC capture (mig 463); projection 'p2p-peer-grants' (projections/p2p-peer-grants.ts),
  // which RECEIVER-ENFORCES author-attestation == grantor before applying (M6/L9).
  'p2p_peer_grants',
  // p2p-work-distribution-2026-07-02 (P-004): loud-refusal receipt FACTS — immutable
  // INSERT-only rows (gate_verdicts pattern), keyed (workspace_id, harness_slug = the
  // hive HOME, receipt_id). Federate so the REQUESTER's machines receive their receipt
  // and p2p:trace assembles the cross-machine timeline (M21). Producer = CDC capture
  // (mig 468); projection 'p2p-receipts' (projections/p2p-receipts.ts), receiver-
  // enforced (author attestation == responder).
  'p2p_receipts',
  // p2p-work-distribution-2026-07-02 (P-101 / D-006): the owner-SIGNED fleet
  // directory record — keyed (workspace_id, harness_slug = the hive HOME,
  // owner_github_user_id, fleet_slug) → workspace-owned + peer-log; federates so
  // every member machine can browse the directory and resolve publisher sets.
  // Producer = CDC capture (mig 476, key = the generated fleet_dir_fed_key);
  // projection 'p2p-fleet-directory' (projections/fleet-directory.ts), which
  // VERIFIES the device signature + device→owner attestation before applying
  // (hive identity key honored only for archived=true — the H10 force-archive).
  'p2p_fleet_directory',
  // p2p-work-distribution-2026-07-02 (P-102 store leg, WI-1935; D-005 seat-offers
  // ride it): the publisher-SIGNED offer store — one record per (hive, publisher,
  // offer-id), keyed harness_slug = the hive HOME → workspace-owned + peer-log.
  // Mirrors p2p_fleet_directory (its stated closest analog). Producer = CDC capture
  // (mig 490, local_disposition excluded from the WHEN list — host-local refusal
  // never federates); projection 'p2p-work-offers' (projections/work-offers.ts),
  // which verifies device signature + device→publisher attestation before apply.
  // [Registry entry added by su-16e4c to green the capture-coverage /
  // checkPeerLogConsistency guards: mig 490 + mapper + projection landed without
  // this classification (5 reds at HEAD) — flagged to WI-1935 owner su-35c3b.]
  'p2p_work_offers',
  // P-302 LIVE-2 seam 1 (WI-2001): the fleet-leader lease row — keyed
  // (workspace_id, harness_slug = the hive HOME, owner_github_user_id,
  // fleet_slug) → workspace-owned + peer-log. It is a liveness/anti-flap hint
  // (not authorization); producer = CDC capture (mig 518), projection
  // 'p2p-fleet-leader-leases'.
  'p2p_fleet_leader_leases',
  // federated-scout-gym-learning-2026-07-02 (F1-1): SHAREABLE standing facts federate
  // as hive state (mig 461 capture triggers, shareable=true rows only — D-006 privacy;
  // apply side partitions by receiver-stamped source_hive, H6). Keyed (workspace_id,
  // scope, scope_ref, key, source_hive) → workspace-owned + peer-log. Projection
  // 'agent-facts-by-key' (projections/agent-facts.ts). [Registry entry added by Lane A
  // su-71623 to green the capture-coverage guard: the CDC capture (mig 461) + mapper
  // landed without this classification, which red-pinned checkSubstrateCaptureCoverage
  // for every table — flagged to the F1-1 owner su-29e3d.]
  'agent_facts',
  // mem0-cross-machine-federation-2026-07-10 (F1-1 mirror for memories, EI-9430 fix):
  // SHAREABLE memories federate as hive state (mig 562-563 capture triggers,
  // shareable=true rows only — D-006 privacy; apply side partitions by
  // receiver-stamped source_hive, H6). Keyed (workspace_id, id, source_hive) →
  // slug-shared + peer-log. Projection tag 'p2p-memories-by-id'
  // (projections/p2p-memories.ts). Capture triggers enqueue only shareable=true
  // rows to the substrate outbox.
  //
  // NOTE (EI-9430): the federated table is `memory_canonical` itself — there is
  // NO separate `p2p_memories` table (that was this entry's classification-key
  // name, not a real table; it silently drifted the peer-log/capture-coverage
  // guards, since neither PEER_LOG_TAG_TO_TABLE nor TABLE_NAME_TO_TABLE_TAG could
  // ever match a table that doesn't exist). Named to the REAL table below so
  // `resolveTableSpec('memory_canonical')` actually returns peer-log (it would
  // otherwise fall through to the `memory_` WORKSPACE_OWNED_PREFIXES rule).
  'memory_canonical',
  // federated-scout-gym-learning-2026-07-02 (F1-2/F1-5): the gym QD archive's
  // FEDERATABLE elites (D-002: outcome=won OR grade>=4) federate as hive state.
  // Producer = CDC capture (mig 464, gated WHEN federatable); receive side writes
  // ONLY harness_shared.gym_qd_foreign_elites (mig 465 — provenance in the PK, so
  // a peer's op can never touch a local archive row). Projection
  // 'gym-qd-elites-by-niche' (projections/gym-qd-elites.ts).
  'gym_qd_archive',
];

/**
 * Workspace-owned config/settings that DON'T match a prefix rule below.
 * (across-workspaces D-1: "config becomes fully workspace-owned".)
 */
const WORKSPACE_OWNED_EXPLICIT = [
  'harness_prompt_overrides',     // the (workspace,harness,role) 3-tier override — across-workspaces Phase 1b
  'orchestrator_settings', 'setup_wizard_state', 'workspace_backup_settings',
  'pr_reviewer_settings', 'insights_first_visit', 'known_schema_versions',
  'adaptive_telemetry', 'spawned_agents', 'hidden_plugins',  // P-002 review: per-install/per-workspace
  // P-002 completeness review (classifyInventory over live schema surfaced these per-workspace tables):
  'harness_registry',          // per-workspace harness membership list (one JSONB row/workspace) — NOT slug-shared
  'autoloop_state', 'harness_dock_layouts', 'saved_prompts',
  'harness_brainstorm', 'plan_revisions', 'plan_runs', 'plan_run_turns', // §7.4 LOCAL Plans = workspace-scoped (harness_plan_review retired by B-14/P-101)
  // NB: engineer_issues moved to PEER_LOG_WORKSPACE_OWNED (fed-reanchor B5) — the
  // work-queue's issue/task family now federates over the Hive peer-log.
  // p2p-work-distribution-2026-07-02 (P-001 / X6): receiver-side high-water epoch
  // per grantor. LOCAL-ONLY enforcement state, deliberately NEVER federated — each
  // receiver derives it from ops it has APPLIED, so a peer cannot lower another
  // machine's fence by federating a row.
  'p2p_grantor_epochs',
  // p2p-work-distribution-2026-07-02 (P-004 / M15): refused-op counters for
  // UNAUTHENTICATED failure paths. LOCAL-ONLY metrics — never federated.
  'p2p_refused_op_counters',
  // federated-scout-gym-learning-2026-07-02 (F1-4 / P-012): per-source counters
  // for FEDERATED CONTENT ops the receive-side projection declined (malformed /
  // not-federatable / rate-capped). LOCAL-ONLY — each receiver counts what IT
  // refused; federating them would let a peer skew another machine's metrics.
  'federation_refused_op_counters',
  // p2p-work-distribution-2026-07-02 (P-205 / WI-1938, mig 483): the durable
  // metering + contribution ledger. LOCAL-ONLY, never federated (PRIVACY — raw
  // account totals + per-user breakdowns must not leave the machine; peers see
  // only the fleet-scoped remainder projection metering-ledger.ts builds).
  'p2p_metering_spend',
  'p2p_metering_contribution',
  // WI-36644 (migration 761): per-call delivery-attempt audit log for notifyAttention() —
  // operator-instance telemetry about THIS box's own owner-notification attempts, never
  // federated (a peer must never learn / influence another machine's delivery record).
  'attention_notifications',
];

/**
 * SECURITY (§7.5) — credentials / tokens / principals. NEVER cross machines
 * (sync forced to 'none'); workspace-owned.
 */
const SECURITY = [
  'operator_credentials', 'operator_secrets', 'operator_publish_credentials',
  'operator_search_provider_credentials', 'operator_voice_credentials',
  'operator_integration_credentials',
  'operator_marketplace_token', 'operator_trust_store',
  'oauth_nonces', 'mobile_pair_tokens', 'mobile_push_tokens', 'token_index',
  'spawn_sig_verification_failures', 'system_principals',
  'system_principal_activity', 'trusted_authors',
  'provision_state', 'provision_audit_log', 'auth_audit_log', 'webhook_audit',
];

/**
 * Name-prefix → workspace-owned (operator/user/session/device-personal +
 * P-002-reviewed per-install operational classes: coord, plugin, backup,
 * telemetry, mem0, invocations).
 */
const WORKSPACE_OWNED_PREFIXES = [
  'operator_', 'user_', 'users', 'auth_', 'mobile_', 'voice_', 'ui_',
  'pi_sessions', 'power_user_sessions', 'adv_sessions',
  'coord_', 'plugin_', 'backup_', 'telemetry_', 'memory_',
  'tool_invocations', 'route_invocations',
];

/** Legacy / dead surfaces — classified DEFAULT, not extended. Currently empty:
 *  the papercup-org/department tables (D-008) that filled this were dropped in
 *  migration 192. Kept as the classification slot for any future dead table. */
const LEGACY_DEAD: string[] = [];

const GIT_SET = new Set(GIT_DOCS);
const PEER_SET = new Set(PEER_LOG_LIVE);
const PEER_WS_SET = new Set(PEER_LOG_WORKSPACE_OWNED);
const WS_EXPLICIT_SET = new Set(WORKSPACE_OWNED_EXPLICIT);
const SECURITY_SET = new Set(SECURITY);
const LEGACY_SET = new Set(LEGACY_DEAD);

/** The registry's sync-authority sets, exported for the projection engine (P-003).
 *  PEER_LOG_TABLES is the full federated set regardless of key axis — both the
 *  slug-shared live tables and the workspace-owned plans table. */
export const PEER_LOG_TABLES: readonly string[] = [...PEER_LOG_LIVE, ...PEER_LOG_WORKSPACE_OWNED];
export const GIT_TABLES: readonly string[] = GIT_DOCS;

/**
 * WI-10003731: tables that WERE sync:'git' and were reclassified as per-HOST
 * machine state (rule (b) above). They now resolve to DEFAULT (sync:'none').
 *
 *   • `harness_escalations` — every writer is a machine-local watchdog
 *     (git-sync stall, origin freshness, green stall, github-bridge divergence,
 *     mcp-dark, codex rollout, fixer liveness, …) re-UPSERTing ITS OWN host's
 *     verdict under the same (harness_slug, phase) key. Git-exporting that made
 *     every device of a multi-device pot commit a different body for the same
 *     `.papercusp/state/escalations/<phase>.md`, so every member head
 *     content-conflicted with staging and the pot-git integrator skipped it
 *     forever (measured on the P-505 physical drill 2026-09-28: tower staging
 *     dd578ec5 vs VM head ba9ce0fb conflicted on exactly github-bridge.md +
 *     origin-freshness-watchdog.md). WI-10003624's refresh-stamp stripping only
 *     stopped ONE host re-committing an unchanged verdict; it cannot reconcile
 *     two hosts' different verdicts, which is the actual conflict.
 *
 * Repos written under the old classification still carry these files. Nothing
 * hydrates from them any more (hydrate only reads GIT_TABLES), and the pot-git
 * integrator resolves a merge conflict confined to their directories in favour
 * of the integrated staging side (`integrator.ts`), so existing diverged member
 * heads converge instead of being parked.
 */
export const RETIRED_HOST_LOCAL_GIT_TABLES: readonly string[] = ['harness_escalations'];

/**
 * Remaining genuine judgment calls — EMPTY as of P-002 close. New entries here
 * mark a table whose classification an owner must confirm before it ships.
 */
export const NEEDS_REVIEW: Record<string, string> = {};

/**
 * Resolve a table's two-axis spec. Order: security → git → peer-log →
 * workspace-explicit → legacy → workspace-prefix → DEFAULT. Strip a
 * `harness_shared.` / `papercusp_shared.` schema qualifier before calling.
 */
export function resolveTableSpec(table: string): TableSpec {
  const t = table.includes('.') ? table.slice(table.indexOf('.') + 1) : table;
  if (SECURITY_SET.has(t)) return { key: 'workspace-owned', sync: 'none', security: true, note: '§7.5 SECURITY' };
  if (GIT_SET.has(t)) return { key: 'slug-shared', sync: 'git', note: '§7.2 GIT document' };
  if (PEER_SET.has(t)) return { key: 'slug-shared', sync: 'peer-log', note: '§7.1 live shared' };
  if (PEER_WS_SET.has(t)) return { key: 'workspace-owned', sync: 'peer-log', note: 'plans: workspace-owned + federated (D-004)' };
  if (WS_EXPLICIT_SET.has(t)) return { key: 'workspace-owned', sync: 'none', note: 'config/settings (D-1)' };
  if (LEGACY_SET.has(t)) return { ...DEFAULT_SPEC, legacy: true, note: 'legacy/dead — D-008 papercup-org' };
  for (const p of WORKSPACE_OWNED_PREFIXES) {
    if (t === p || t.startsWith(p)) return { key: 'workspace-owned', sync: 'none', note: `prefix:${p}` };
  }
  return { ...DEFAULT_SPEC };
}

/** True if the table's classification is still a pending judgment call. */
export function needsReview(table: string): boolean {
  const t = table.includes('.') ? table.slice(table.indexOf('.') + 1) : table;
  return t in NEEDS_REVIEW;
}

export interface InventoryClassification {
  total: number;
  /** count per `${key}/${sync}` bucket. */
  byBucket: Record<string, number>;
  /** tables that fell through to DEFAULT (slug-shared/none) — intentional, but reviewable. */
  defaulted: string[];
  /** tables still flagged NEEDS_REVIEW (should be empty at/after P-002 close). */
  unreviewed: string[];
}

/**
 * Classify a full list of live tables (P-003 engine boot passes the live
 * `information_schema` set here). Surfaces the DEFAULT fall-through set + any
 * still-unreviewed table so a NEW table can never silently inherit DEFAULT
 * without someone seeing it.
 */
export function classifyInventory(tables: string[]): InventoryClassification {
  const byBucket: Record<string, number> = {};
  const defaulted: string[] = [];
  const unreviewed: string[] = [];
  for (const raw of tables) {
    const t = raw.includes('.') ? raw.slice(raw.indexOf('.') + 1) : raw;
    const spec = resolveTableSpec(t);
    const bucket = `${spec.key}/${spec.sync}${spec.security ? '/sec' : ''}${spec.legacy ? '/legacy' : ''}`;
    byBucket[bucket] = (byBucket[bucket] ?? 0) + 1;
    const isExplicit =
      SECURITY_SET.has(t) || GIT_SET.has(t) || PEER_SET.has(t) || PEER_WS_SET.has(t) ||
      WS_EXPLICIT_SET.has(t) || LEGACY_SET.has(t) ||
      WORKSPACE_OWNED_PREFIXES.some((p) => t === p || t.startsWith(p));
    if (!isExplicit) defaulted.push(t);
    if (needsReview(t)) unreviewed.push(t);
  }
  return { total: tables.length, byBucket, defaulted, unreviewed };
}
