/**
 * Reverse map: PG table → camelCase queryNames that read from it.
 *
 * Used by the sync-sse.ts LISTEN handler to bridge PG-trigger-driven
 * `emit_change_notify` events to the established camelCase consumer
 * subscriptions (P-067 from papercusp-dogfood-v5).
 *
 * Without this bridge, a PG INSERT on `harness_shared.harness_text_artifacts`
 * fires a `harness_shared.harness_text_artifacts.changed` event, but
 * existing `useSyncQuery({ queryName: 'harnessTextArtifact.byHarness' })`
 * subscribers see no matching name and don't refetch. With this bridge,
 * the LISTEN handler synthesizes additional events with the camelCase
 * names the consumers subscribe to. The dedupe window in sync-sse.ts
 * collapses repeated identical (name, args) within 90s, so this stays
 * cheap even under heavy write load.
 *
 * Maintenance: each entry corresponds to a v2 registry entry in
 * `apps/operator/lib/sync-resolver/index.ts`. When you add a new
 * registry entry that reads from table T, add (T → name) here too.
 * The `T` is the FULL `<schema>.<table>` string that the PG trigger
 * emits.
 *
 * Scoped (per-row) invalidation — caching-layer-tag-eca-2026-06-22 P-006:
 * migration 368 made `emit_change_notify` emit the changed row's PK in
 * `args.id` (+ a corrected `args.workspace_id`). Where a mapped query is
 * keyed PER-ROW, the bridge now uses `args.id` to invalidate ONLY that
 * row's cache key instead of full-busting the whole query.
 *
 *   - A bare-STRING entry (the default, and every entry today) → FULL-BUST:
 *     the bridge emits the name with NO `args`, so the SSEAdapter's
 *     name-only predicate invalidates every cache entry under that name.
 *     This is correct and unchanged for queries keyed by harness_slug /
 *     workspace_id / plan_slug etc. — a `byHarness` list isn't keyed by the
 *     changed row's surrogate PK, so per-row scoping can't narrow it.
 *
 *   - A `{ name, scope }` entry → SCOPED when the event carries an identifying
 *     key (`args.id`, or a natural-key fallback like `args.plan_slug` for
 *     id-less tables — EI-7433) AND `scope(key, workspaceId)` returns a key
 *     object. The bridge emits the name WITH those `args`; the SSEAdapter
 *     invalidates via `queryClient.invalidateQueries({ queryKey })`, which is
 *     a NON-exact, PARTIAL match (`@tanstack/react-query`'s
 *     `partialMatchKey` — verified live against v5.100.5): every key `scope`
 *     returns must match the consumer's cached args, but the consumer's args
 *     MAY carry additional keys `scope` omits (e.g. `mode`, `harness`) — they
 *     are not required to match. So `scope` only needs to return the subset
 *     of args that uniquely identifies the row (e.g. `{ slug }`), NOT the
 *     consumer's complete args object — a MISSING key in `scope`'s return is
 *     fine, a WRONG value for a key it does include is what breaks the
 *     match. Returns `null` to opt out of scoping for this event → the
 *     bridge falls back to a full-bust for that name. When the event has NO
 *     identifying key at all (neither `id` nor a nominated natural key),
 *     every entry full-busts regardless.
 *
 * The fan-out (and the 90s (name,args) dedupe in the bus) stays cheap: a
 * scoped event dedupes per row, a full-bust dedupes per name.
 */

/** Build the scope (consumer-key) args for a per-row query from the event's
 *  row PK + workspace. Return `null` to fall back to a full-bust. */
export type ScopeKeyBuilder = (rowId: string, workspaceId: string | undefined) => Record<string, unknown> | null;

/** A mapped target: a bare query name (full-bust) or a name + per-row scope. */
export type QueryNameTarget = string | { name: string; scope: ScopeKeyBuilder };

/**
 * Map of (schema.table) → camelCase queryNames that scope reads on it.
 * Keys are the exact strings the PG trigger emits in the `name` field
 * (`harness_shared.<table>.changed` becomes the lookup key after
 * stripping the `.changed` suffix). Values are {@link QueryNameTarget}s —
 * a bare string full-busts; `{ name, scope }` opts into per-row scoping.
 */
export const TABLE_TO_QUERY_NAMES: Readonly<Record<string, readonly QueryNameTarget[]>> = {
  // Reports have a composite workspace/report key, so a table event without a
  // consumer reportId conservatively refreshes every open pinned report.
  'harness_shared.report_library': ['reports.get'],
  // Occurrence watermarks alter the observation page and its exact summary even
  // when the canonical work-item row is unchanged.
  'harness_shared.work_item_occurrences': ['learning.observations', 'learning.observations.summary'],
  // Cloud Workspaces (WI-40483 / P-023): all low-volume durable control
  // tables push the single provider-neutral projection. workspace_host_logs
  // is intentionally absent because appendWorkspaceHostLogs emits one scoped
  // producer invalidation after each batch instead of one PG NOTIFY per line.
  'harness_shared.workspace_host_connections': ['workspaceHosts.control'],
  'harness_shared.workspace_hosts': ['workspaceHosts.control'],
  'harness_shared.workspace_host_operations': ['workspaceHosts.control'],
  'harness_shared.workspace_host_resources': ['workspaceHosts.control'],
  'harness_shared.workspace_host_events': ['workspaceHosts.control'],

  // The harness registry is one JSONB row per workspace (mig 025); its
  // trigger (mig 222) is what defeats the bus's 90s source-side dedupe for
  // back-to-back registry changes (EI-206 — a create followed by a delete
  // inside the window left open harness lists stale).
  // network.board: a hive create/dissolve changes its tier 1–2 rows.
  'harness_shared.harness_registry': [
    'harnessProjects.lite',
    'harnessWorkspaces.byHarness',
    'network.board',
    'kpis.all',
  ],
  'harness_shared.contributors': ['contributors.byHarness'],
  // auto_review_audit also feeds the PR-reviewer settings modal's audit log
  // (WI-4138 / P-011) — a poll-daemon audit row live-refreshes it.
  'harness_shared.auto_review_audit': ['contributors.byHarness', 'prReviewerSettings.byHarness'],
  // pr_reviewer_settings / trusted_authors (WI-4138 / P-011): the settings
  // toggle + trust-list halves of the same modal. Full-bust (no natural key
  // to scope by harness_slug on these viewer-keyed tables — the id-less
  // scope fallback only covers harness_plans/pot_settings today), matching
  // most of this map; low write rate keeps that cheap.
  'harness_shared.pr_reviewer_settings': ['prReviewerSettings.byHarness', 'harnessPrs.detail'],
  'harness_shared.pr_review_reports': ['harnessPrs.byHarness', 'harnessPrs.detail'],
  'harness_shared.pr_check_status_cache': ['harnessPrs.byHarness', 'harnessPrs.detail'],
  'harness_shared.shared_repo_binding_cache': ['harnessPrs.detail'],
  'harness_shared.trusted_authors': ['prReviewerSettings.byHarness'],
  // planSessions.list (owner-plans-single-pane P-004): the plan popup's
  // Sessions tab is keyed by plan_slug, not a row PK — full-bust here so a new
  // session recorded for a plan (or one ending) live-refreshes the tab. Low
  // write rate + a small per-plan payload keep the broad bust cheap.
  'harness_shared.adv_sessions': [
    'advSessions.list',
    'advSessions.summary',
    'advRoster.list',
    'planSessions.list',
    'conversations.contextProjection',
    'identities.surface',
  ],
  'harness_shared.session_briefs': ['identities.surface'],
  'harness_shared.session_identity_activation_events': ['identities.surface'],
  /* agent_modes — the standing MODE per agent per axis (auto / ideate / drain /
     grade). session-chat-popup-timestamps-and-modes-2026-08-09 P-003; trigger
     attached in migration 763.
     [owner 2026-08-09] "I changed drain mode from off to on, but the display
     still showed off afterward." — `mode:set` wrote this table and NOTHING
     refetched, because the table had no trigger and no entry here. Both halves
     were missing; either one alone is inert.
     Full-bust rather than row-keyed: every consumer is keyed by owner/workspace
     rather than by this table's PK, and the write rate is a human or an agent
     deciding to change posture — not telemetry. */
  'harness_shared.agent_modes': [
    // The roster row's `modes`, which is what the chat control band's mode pills
    // and the HUD's mode chips both read. This is the one the owner watched fail
    // to update.
    'advRoster.list',
    // The dossier half of the session popup — it shows what the agent was TOLD,
    // modes included, so it goes stale on exactly this write.
    'agentDetail.byOwner',
    // goals.detail (P-018/D-007) — the goal↔agent pairing lives in
    // `agent_modes.subject`; there is no dedicated column and no join table, so
    // resolveGoalDetail selects FROM agent_modes directly (goals.ts). An agent
    // started on (or stopped off) this goal must therefore repaint the goal
    // popup's conversation affordance. Full-bust for this entry's stated reason:
    // the consumer is keyed by goalId, never by this table's PK. Unlike
    // agentOrders.byOwner below there is NO producer-side push for goals.detail —
    // this entry is its only invalidation path, so dropping it silently returns
    // the popup to remount-only refresh.
    'goals.detail',
    // P-030: foreign conversation contexts render the same official mode rows
    // as the roster rather than reconstructing posture from transcript prose.
    'conversations.contextProjection',
    /* NOT `agentOrders.byOwner`, deliberately — this list ORIGINALLY named it and
       that was a regression in two ways (caught by resolver-backing-table-coverage's
       stale-PUSH_EXEMPT guard, which is precisely what that guard is for).

       1. REDUNDANT. modes/store.ts already calls notifyAgentOrdersChanged(ownerId)
          on both write paths (L175, L201 — verified, not assumed), so the Orders
          panel was ALREADY live on a mode change. The bridge entry bought nothing.
       2. STRICTLY WORSE. That push is scoped to `{ ownerId }`, so it refetches the
          ONE panel viewing that agent. A table trigger cannot see the owner, so it
          full-busts EVERY open Orders panel whenever ANY agent changes posture —
          exactly the cost WI-6974 removed, re-added by a one-line list entry.

       The PUSH_EXEMPT entry for this pair therefore stays TRUE and stays put. Its
       own RE-ARM note already called this shot: wire the table here only if the
       producer push is dropped, OR if the bridge gains an owner-scoped
       `{ name, scope }` target — scoping is what would make a trigger safe, and
       there is still no production user of that mechanism. */
  ],
  // saved_prompts backs the Quick Panel prompts outline (savedPrompts.byScope).
  // Trigger attached in migration 598 (quick-panel-saved-prompts-2026-07-13):
  // full-bust — the query is keyed by scope (harness), not the row PK.
  'harness_shared.saved_prompts': ['savedPrompts.byScope'],
  // ── Per-harness HYPERBEE-bucket tables ────────────────────────────
  'harness_shared.harness_text_artifacts': ['harnessTextArtifact.byHarness'],
  // harness_design_artifacts backs the Design tab's sketch pane (designSketches.byFeature).
  // Trigger attached in mig 380 (data-sync-push-completion P-003) so a sketch save — POST
  // /api/design/sketches, raw SQL, or a FEDERATED git-doc write — pushes the pane live.
  'harness_shared.harness_design_artifacts': ['designSketches.byFeature'],
  'harness_shared.harness_project_files': ['harnessProjectFiles.byHarness'],
  'harness_shared.adaptive_telemetry': ['adaptiveTelemetry.byHarness'],
  // Personal Vault archive uploads publish into durable jobs. Both table
  // transitions invalidate the same owner-scoped Settings queue; the bridge
  // full-busts because trigger payloads carry row/workspace identity, not the
  // userId used by the consumer key.
  'harness_shared.personal_vault_import_jobs': ['personalVault.importJobs'],
  'harness_shared.personal_vault_import_uploads': ['personalVault.importJobs'],
  'harness_shared.harness_skills': ['harnessSkills.byHarness'],
  'harness_shared.harness_decisions': ['harnessDecisions.byHarness'],
  'harness_shared.harness_lanes': ['harnessLanes.byHarness', 'harnessLanes.snapshot'],
  'harness_shared.harness_escalations': ['harnessEscalations.byHarness'],
  'harness_shared.harness_checkpoints': ['harnessCheckpoints.byHarness'],
  'harness_shared.harness_feature_prs': ['featurePrs.byHarness', 'featureTimeline.byFeature', 'harnessPrs.byHarness', 'harnessPrs.detail'],
  'harness_shared.harness_status': ['harnessStatus.byHarness'],
  'harness_shared.harness_tests': ['harnessTests.byHarness'],
  'harness_shared.harness_archives': ['harnessArchives.byHarness'],
  'harness_shared.harness_hook_logs': ['harnessHookLogs.byHarness'],
  'harness_shared.harness_smoke_test': ['harnessSmokeTest.byHarness'],
  // Plans went PG-canonical (plans-pg-canonical-migration-2026-06-03): a write to
  // harness_plans invalidates the plan directory + per-plan reads. plan_revisions
  // / plan_runs feed the audit + run panels.
  'harness_shared.harness_plans': [
    // P-017 slice D: plan DECISIONS and the current spec are protected rows inside the
    // prior-attempt brief, so adding a decision changes what an open panel should show.
    'workItems.priorAttempts',
    // P-011: the acceptance gate reads the plan row itself — its status, its exemption
    // class, and the `forcedPast` waiver stamped onto it. A force recorded on the plan
    // must not leave an open verdict panel still claiming an unwaived pass.
    'plans.acceptanceGate',
    // plan-item-provenance P-004: an added/dropped item changes the per-item provenance view.
    'plans.provenance',
    'plans.list',
    'coord.plans',
    // plans.get (EI-7433): scoped by plan slug (mig 507's natural-key
    // fallback). The one live consumer (usePlan's `live:true` path,
    // apps/operator/app/admin/plans/plans-api.ts) always subscribes with
    // `{ slug, mode:'full', ...(harness && {harness}) }` — `scope` only
    // needs to return `{ slug }` (a MATCHING subset; extra consumer-side
    // keys like `mode`/`harness` are not required to match — see the
    // file-top note). `planSlugScope` falls back to full-bust when the
    // event carries no plan_slug (shouldn't happen for this table, but a
    // defensive `null` costs nothing).
    { name: 'plans.get', scope: planSlugScope },
    // plans.items stays a full-bust — but NOT for the reason this comment used
    // to give. It claimed "no live useSyncQuery consumer today"; that lapsed
    // (WI-7086). There are now four: usePlanItems() with `{needsHuman:true}` /
    // `{actionable:true}` / `{status:'blocked'}` (PlansClient, use-create-data)
    // and HydratedWorkRefPill with `{slug}`.
    //
    // Knowing the shapes makes the case for full-bust STRONGER, not weaker.
    // `planSlugScope` emits `{slug}`, and a scope must be a MATCHING SUBSET of
    // the consumer's args — so it would match only the pill and leave the three
    // slug-less bucket queries subscribed to a scope they can never match, i.e.
    // silently never refreshing. That is precisely the failure the old comment
    // feared; scoping this name needs a predicate over a UNION of arg shapes,
    // which the scope grammar does not express.
    'plans.items',
    'plans.attention',
    // plans.attentionItem (slim-plans-attention-sync-payload-2026-07-26 P-004) —
    // the detail half of the attention split. Full-bust for the same reason
    // plans.items is: its consumer args are `{ id, ...scope }`, and `id` is an
    // attention-item id (e.g. `coord-message:m1`), NOT a plan slug, so
    // planSlugScope cannot match it. It must invalidate WITH plans.attention or
    // an open detail pane keeps showing a resolved item's stale actions.
    'plans.attentionItem',
    // plans.attentionCounts (WI-5955) — the badge aggregate. MUST invalidate with
    // plans.attention or the "needs you" badge goes stale while the list beside
    // it updates, which is exactly the badge-vs-pane disagreement the counts were
    // designed to avoid.
    'plans.attentionCounts',
    // plans.attentionRefs (D-031) — the drill-in projection. Same rule as the
    // two above: it MUST invalidate with plans.attention, or a chat card's Open
    // button keeps rendering (or stops rendering) against a resolved item that
    // has since left the feed.
    'plans.attentionRefs',
    // plans.waitingCount was removed from this list 2026-08-10 with the resolver
    // itself (P-075) — its only consumer, the "N plans waiting" nudge, was
    // deleted by owner directive, so the entry would have been invalidating a
    // query that no longer exists.
    //
    // plans.steerable (D-071) — the Mug steering panel's 6-field plan
    // projection. Reads harness_plans via callPlansRead('list', ...), same as
    // plans.list above, so it MUST invalidate alongside it: a plan
    // shipped/superseded/archived (or one whose startStatus
    // flips) has to leave/enter the steering checkboxes live, or the owner
    // steers against a list that no longer matches reality.
    'plans.steerable',
    'plans.search',
    // plans.byHive (WI-259 P-006) — the cross-member plan rollup. A FEDERATED plan
    // write lands on harness_plans under the author member's slug + fires the change
    // notify, so a peer member's new/edited plan live-refreshes the hive rollup.
    'plans.byHive',
    // plans.schedule + plans.scheduledOccurrences (data-sync-push-completion P-002) —
    // the schedule lives in COLUMNS on harness_plans (schedule jsonb / schedule_active /
    // scheduled_at / expires_at / tzid — mig 299), NOT a separate plan_schedules table.
    // Every schedule-write path writes harness_plans: plans:set-schedule (setPlanSchedule),
    // plans:arm-schedule / disarm-schedule (UPDATE … SET schedule_active), and the routine
    // engine's own one-shot/expiry deactivations. Bridging here pushes the Calendar
    // (scheduledOccurrences, window-keyed → full-bust) + Routines (schedule) panes live on
    // ANY of those writes — including raw SQL / FEDERATED — which an explicit
    // notifySyncInvalidate in the 3 tools alone would miss.
    'plans.schedule',
    'plans.scheduledOccurrences',
    // P-010: historical sessions without launch_spec.harnessSlug inherit an
    // unambiguous plan→harness mapping. A plan move therefore changes both the
    // row projection and its exact harness/plan companion facets.
    'advSessions.list',
    'advSessions.summary',
    // Rubrics are plan-doc-backed (template = rubric, lib/rubrics.ts
    // queryRubricPlans). A create/ratify/edit changes the overview, history-row
    // completeness projection, and trend dimensions. P-009 keeps the paired
    // history summary on the exact same invalidation set as its row page.
    'rubrics.list',
    'scorecards.list',
    'scorecards.summary',
    'rubrics.trend',
    // goals.detail (P-019/D-010) — the goal popup's plans rail LEFT JOINs
    // harness_plans for each derived plan's title + status (goals.ts
    // resolveGoalDetail). The rail's ROW LIST is invalidated by work_items, but
    // the JOINED columns come from here, so without this entry a plan renamed,
    // archived or shipped after the popup opened keeps rendering its old label.
    // Full-bust rather than `planSlugScope`, for the reason plans.items above
    // documents: goals.detail's args are `{ workspaceId, goalId, activityLimit }`
    // and carry no `slug`, so a `{ slug }` scope could never be a matching subset
    // and the query would sit subscribed to a scope it can never match — i.e.
    // silently never refreshing, which is the exact failure this list prevents.
    'goals.detail',
    // learning.retainFeed / learning.retainDetail (WI-39493/WI-39534): the
    // Retained ledger's plans leg (and rubrics, which are plan-doc-backed) and
    // an open plan/rubric detail aside. Full-bust: the feed is cursor-keyed and
    // the detail is `{ kind, id }`-keyed, so no plan-slug scope can match.
    'learning.retainFeed',
    'learning.retainFeed.summary',
    'learning.retainDetail',
    // WI-6182: the Retain strip's 7d plan count and the Scout draft-plan
    // join both render columns from this row.
    'learning.retain',
    'learning.scoutDrafts',
    // WI-39900: the tab badges are their own query now. A plan write changes
    // the plans/rubrics corpus SIZE, so it must bust the counts too — otherwise
    // the badge and the ledger it labels drift apart until the next mount.
    'learning.retainCounts',
  ],
  // planActivity.list (plan-visibility-revamp-2026-08-23 P-004) — the plan
  // dashboard's merged activity feed reads revisions as its EDITS leg. Full-bust:
  // the feed is planSlug-keyed and this trigger carries no plan_slug natural key.
  'harness_shared.plan_revisions': ['plans.revisions', 'planActivity.list'],
  // plan_runs feeds BOTH the Agents-tab flat list (plans.runs, { slug }) and the
  // Runs-tab history+rollup (plans.runHistory, { planSlug }) — a row write busts both.
  'harness_shared.plan_runs': ['plans.runs', 'plans.runHistory'],
  'harness_shared.harness_brainstorm': ['harnessBrainstorm.byHarness'],
  'harness_shared.pending_reviews': ['pendingReviews.byHarness'],
  'harness_shared.harness_pending_issues': ['harnessPendingIssues.byHarness'],
  'harness_shared.harness_screenshots': ['harnessScreenshots.byHarness'],
  'harness_shared.agent_chats_consolidated': [
    'agentChats.byHarness',
    { name: 'agentChats.detail', scope: idScope },
    'conversations.agentChatList',
    { name: 'conversations.agentChatDetail', scope: idScope },
    'conversations.contextProjection',
  ],
  // P-029 projection children use sessionId rather than the source tables'
  // heterogeneous PK names, so writes intentionally full-bust the small set of
  // mounted context projections by query name.
  'harness_shared.agent_loop_sessions': ['conversations.contextProjection'],
  'harness_shared.agent_loop_approvals': ['conversations.contextProjection'],
  'harness_shared.session_tasks': ['conversations.contextProjection'],
  'harness_shared.coord_conversations': [
    'conversations.questionsList',
    { name: 'conversations.questionDetail', scope: idScope },
    // EI-19304902443341820: `sidebar.conversations` (the Swarm comms all-hands list) reads this
    // SAME table via listConversations, but was never in this list — so a new conversation never
    // pushed to it and the list refreshed on remount only. The accounts.pool shape exactly: the
    // table was mapped, just not to every query that reads it, which is the variant a
    // table-presence check cannot see. Found by the resolver→table coverage guard.
    'sidebar.conversations',
  ],
  // A coord thread can be a standalone deliberation OR the timeline attached
  // to a Q&A conversation. These tables do not expose a trigger id that matches
  // the parent/detail key, so detail queries intentionally full-bust by name.
  'harness_shared.coord_threads': [
    'conversations.deliberationList',
    'conversations.deliberationDetail',
    'conversations.questionDetail',
  ],
  'harness_shared.coord_thread_posts': [
    'conversations.deliberationList',
    'conversations.deliberationDetail',
    'conversations.questionDetail',
  ],
  // Tag and subscriber changes alter the Q&A list/detail projections even
  // though the conversation scalar row itself does not change.
  'harness_shared.coord_entity_subscriptions': ['conversations.questionDetail'],
  // coord_event_log has TWO independent consumer families, and they MUST stay in
  // this single entry — an object literal cannot repeat a key, and a duplicate
  // does not merge, it SILENTLY OVERRIDES. That is exactly what happened on
  // 2026-07-27: `conversations-agent-messages-2026-07-27` added a second
  // 'harness_shared.coord_event_log' key here while one already existed further
  // down, so the later literal won and the agent-message conversation queries
  // below were never invalidated by any coord write — the brand-new source would
  // simply never refresh. It also emitted TS1117, which hard-fails the typecheck
  // gate regardless of the error baseline and so blocked the whole fleet's green
  // checkpoint. Add new consumers to this array; never re-declare the key.
  //
  // 1. Agent↔agent coord traffic as a curated conversation source
  //    (conversations-agent-messages-2026-07-27). A new envelope can be a new
  //    conversation ROOT (list) or a REPLY that changes an existing root's reply
  //    count and last-activity sort key (list AND detail), and the row carries no
  //    trigger id matching the detail key, so detail full-busts by name — the same
  //    stance coord_threads/coord_thread_posts already take above.
  // 2. dev.coordFeed is the live coordination firehose (the PresenceRail Activity
  //    tab + the /adv Conversations Feed). The emit_change_notify trigger on
  //    coord_event_log is filtered to ORIGINAL rows (body->>'notify_kind' IS NULL)
  //    so the per-subscriber fan-out delivery copies don't each fire — the busiest
  //    coord table stays cheap (shared-hive-collaboration P-006). The (name,args)
  //    dedupe bounds burst refetches.
  'harness_shared.coord_event_log': [
    'conversations.agentMessageList',
    'conversations.agentMessageDetail',
    'dev.coordFeed',
    'coord.history',
    'coord.inbox',
    // EI-19304902443341820: `sidebar.cupMail` reads this same log (readInbox/readOutbox) for the
    // Swarm view's per-agent mailbox, but was never listed — so a coord message pushed to
    // coord.inbox and dev.coordFeed while the mailbox beside them stayed stale until remount.
    // Found by the resolver→table coverage guard. The 90s (name,args) dedupe bounds the extra
    // fan-out on this append-heavy log.
    'sidebar.cupMail',
  ],
  // harness_shared.messages_consolidated entry retired with the work-item
  // mail read queries — see retire-work-item-mail-surface-2026-07-26 P-004.
  'harness_shared.harness_feature_notes': ['featureNotes.byHarness'],
  'harness_shared.harness_feature_debug_notes': ['featureDebugNotes.byHarness', 'featureTimeline.byFeature'],
  'harness_shared.feature_audit_consolidated': ['featureAudit.byHarness'],
  // chunkPlans contributes 2 query names sharing 1 table; both fire.
  'harness_shared.harness_chunk_plans': ['chunkPlans.byHarness', 'chunkPlans.byFeature'],
  'harness_shared.harness_proposals_shared': ['proposalsShared.byHarness'],

  // ── Per-workspace tables ──────────────────────────────────────────
  'harness_shared.toast_log': ['toastLog.recent'],
  'harness_shared.operator_budget': ['operatorBudget.byWorkspace'],
  'harness_shared.operator_conversations': ['operatorConversations.current', 'operatorConversations.byWorkItem'],
  // Both the live tail and the paged bootstrap read this table. In-place
  // choice-card answers mutate an existing row's tools JSON, so invalidating
  // only the live-tail query leaves a reload hydrated from a stale page.
  // operatorReports.latest (overview-tab-expansion P-004): a new <report> turn
  // refreshes the Overview's Operator-report tile on the same write.
  // operatorTurns.byConversation was a member here until EI-19372323793235963 removed
  // the resolver entry it mapped to (P-025 / D-016 — the query merged into
  // operatorTurns.page). Do NOT re-add it: mapping a name no resolver serves is dead
  // wiring, and table-to-query-names.test.ts now fails on it.
  'harness_shared.operator_turns': ['operatorTurns.page', 'operatorReports.latest'],
  'harness_shared.operator_prompt_user': ['operatorConfig.byWorkspace'],
  'harness_shared.operator_preferences': ['operatorConfig.byWorkspace', 'operatorPreferences.byWorkspace'],
  'harness_shared.operator_standing_candidates': ['operatorStandingApprovals.byWorkspace'],
  'harness_shared.operator_voice_prefs': ['voicePrefs.effective', 'voicePrefs.workspace'],
  'harness_shared.user_preferences': ['userPreferences.current', 'voicePrefs.effective'],
  'harness_shared.operator_account_override': ['accounts.sessionOverride', 'accounts.pool'],
  // WI-6796 — the pool table itself. This is the CROSS-PROCESS half of the fix:
  // the writer that matters here is the inference GATEWAY, a separate process, so
  // its saveAccountPool can never reach the operator's in-process
  // notifyOperatorStateSync. Migration 715 attaches emit_change_notify to the
  // table so the write emits `harness_shared.operator_account_pool.changed`, and
  // this bridge turns that into the camelCase `accounts.pool` the AccountsTab +
  // AdvOverviewTab Spend tile actually subscribe to. Full-bust (bare string) is
  // correct: the pool is ONE single-row-per-workspace JSONB doc, so there is no
  // per-row key to scope by.
  'harness_shared.operator_account_pool': ['accounts.pool'],
  'harness_shared.harness_dock_layouts': ['dockLayouts.byName', 'dockLayouts.list'],
  'harness_shared.harness_plan_assertions': ['testing.assertionsByHarness'],
  'harness_shared.projects': ['kpis.all'],
  'harness_shared.autoloop_state': ['kpis.all'],
  'harness_shared.audit_log': ['auditLog.operatorDecisions'],
  'harness_shared.user_actions': ['userActions.byHarness', 'userActions.byKind', 'userActions.recent'],
  'harness_shared.plugin_configs': ['pluginConfigs.byHarness'],
  'harness_shared.plugin_enables': ['pluginEnables.byWorkspace'],
  'harness_shared.project_spec_revisions': ['projectSpecRevisions.byProject'],

  // work-queue-admission-and-bulk-dedup P-005 — the owner-facing run ledger.
  // admission_runs has a row trigger, so census/promoter/bulk writers in ANY
  // process converge an open panel even when they bypass the routine action's
  // producer-side push.
  'harness_shared.admission_runs': ['workItemAdmission.runs'],

  // ── Cross-harness *Consolidated tables ────────────────────────────
  // work_items is the UNIFIED base table (mig-374 renamed harness_features_consolidated
  // -> work_items and backfilled engineer_issues into it). It carries emit_change_notify,
  // so a write — including raw-SQL / FEDERATED — fires harness_shared.work_items.changed.
  // This is the REAL invalidation producer for the work-item read families; the two
  // *_consolidated / engineer_issues names below are now compat VIEWS over work_items
  // (relkind 'v', so they cannot carry a row trigger and never emit .changed themselves —
  // a write routed through a view's INSTEAD-OF trigger still lands on work_items and fires
  // THIS event). The view keys are kept for documentation + are COVERAGE_EXEMPT in
  // cache-tag-trigger-coverage.integration.test.ts.
  /* GOAL mode (goal-mode-2026-08-07 P-017). Three tables feed the goal surfaces
     and each moves for a different reason, so all three are bridged:
       - `goals` — the record itself (status, kill criterion, tripwire `current`
         values, which advance via goals:update as evidence lands);
       - `goal_pots` — attach/detach/promote, which changes BOTH the pot
         grid AND every spend figure, since spend is summed over the linked set;
       - `agent_usage_samples` — the spend meters themselves.
     Full-bust rather than row-keyed: the queries are keyed by workspace/goal
     rather than by these tables' PKs. */
  'harness_shared.goals': ['goals.list', 'goals.detail'],
  'harness_shared.goal_pots': ['goals.list', 'goals.detail'],
  /* NOTE: the goal SPEND meters also go stale on `agent_usage_samples` writes,
     but that table already has an entry further down — the goal queries are
     added THERE rather than here. A second key for the same table in this object
     literal would not merge: the later one silently wins, so the goal queries
     would never be bridged at all and the meters would look simply broken. */

  // P-009 — the History tab's live timeline reads three tables and is a
  // whole-feed read (no id scoping), so ANY write to any of them changes it.
  // The bridge is the mechanism that matters here rather than per-call-site
  // notifies: the timeline's sources are written from ~40 different app paths
  // AND from raw SQL, MCP-tool writes and migrations that never run app code,
  // so an enumerated set of notify call sites would silently miss most of them.
  'harness_shared.plan_items': ['projectHistoryEvents.byHarness'],
  'harness_shared.harness_plan_parts': ['projectHistoryEvents.byHarness'],

  'harness_shared.work_items': [
    // P-009: work-item lifecycle is the bulk of the live History timeline.
    'projectHistoryEvents.byHarness',
    // P-030: current held-work context around a foreign producer session.
    'conversations.contextProjection',
    // P-005: pending/unreviewed queue counts and promoted→first-claim
    // percentiles are rollups over this base table. A claim or admission write
    // must refresh them alongside the admission_runs ledger.
    'workItemAdmission.runs',
    // P-017 slice D: the prior-attempt brief summarizes the whole plan LANE, so a
    // SIBLING item's completion/checkpoint changes it exactly as much as a write to the
    // item the panel is open on. Full-bust for that reason — an id-scoped rule would miss
    // the sibling writes this panel exists to surface. Only ever mounted while a human
    // has the section open (useSyncQuery `enabled`), so the bust costs nothing otherwise.
    'workItems.priorAttempts',
    // P-011: the resolved BehaviorContract reads the item's kind and plan provenance,
    // so a re-stamp or a kind change moves which clauses resolve. Same on-demand
    // mounting as priorAttempts.
    'workItems.behaviorContract',
    // P-011: the adequacy gate reads the same provenance AND grades against scorecards,
    // which are themselves stored as work-item rows — so a re-stamp, a kind change, or a
    // new grading each move the verdict. Same on-demand mounting.
    'workItems.specAdequacy',
    // P-011: adequacy SCORECARDS are stored as work-item rows, so this is the only table
    // a new grading touches. The adequacy leg is advisory-only (D-018), but a census that
    // silently under-reports a gap it claims to measure is the defect this plan exists to
    // end. Same on-demand mounting, so the bust costs nothing while the section is closed.
    'plans.specCoverage',
    // P-011: the acceptance gate grades against SCORECARDS (work-item rows) and counts
    // unfinished PLAN ITEMS — so a grading, a verdict, or an item completion all move it.
    'plans.acceptanceGate',
    // Goal surfaces count OPEN and needs-human items per goal, so a state flip
    // or a new goal-stamped item moves both the rail glance and the detail page.
    'goals.list',
    'goals.detail',
    // P-006: the exact Improve companion reads the complete work-item corpus.
    // Routed-idea-only changes push this same key from routed-ledger.ts.
    'learning.improvements.summary',
    // learning.retainFeed / retainPlanChildren / retainDetail (WI-39493/34/35):
    // the Retained ledger's wi leg, a plan row's expanded children, and an open
    // wi detail aside. Full-bust: cursor-/`{kind,id}`-keyed, no scope can match.
    'learning.retainFeed',
    'learning.retainFeed.summary',
    'learning.retainPlanChildren',
    'learning.retainDetail',
    // WI-6182: engineer_issues is a compat view over this table; a new
    // improvement changes the Retain strip's trailing-7d count.
    'learning.retain',
    // WI-39900: see the harness_plans entry above — the wi badge is a corpus
    // count, so a work-item write moves it.
    'learning.retainCounts',
    // WI-6961: agentOrders.byOwner renders the agent's HELD work-items via
    // buildCarryBrief, so a state/claim write is exactly when the Orders panel
    // is wrong. Coarse (any work_items write invalidates it), but the query is
    // per-ownerId and only subscribed while the popup is actually open.
    'agentOrders.byOwner',
    'featuresConsolidated.bySlug',
    // P-007: the single-feature on-demand detail read (carries the `summary`
    // dropped from bySlug) — bridged wherever bySlug is so an open Detail pane
    // live-refreshes the Description on the same writes that move the list row.
    'featuresConsolidated.detail',
    'featuresConsolidated.byPlanSlug',
    // P-011: rows and their independent exact summary share this producer set.
    // A design-state/title/create write therefore invalidates both members in
    // the same cycle instead of leaving page rows and bucket evidence adjacent.
    'designFeatures.byHarness',
    'designFeatures.summary',
    // WI-7232: the single-feature on-demand detail read (carries the `summary`
    // dropped from designFeatures.byHarness) — bridged wherever byHarness is, so
    // an open detail card live-refreshes its Summary on the same design-state
    // writes that move the list row.
    'designFeatures.detail',
    // featuresConsolidated.byHive (WI-259 P-006) — the cross-member rollup. A
    // FEDERATED content write lands on work_items under the AUTHOR member's slug and
    // fires work_items.changed (emit_change_notify), so a peer member's new/edited
    // feature live-refreshes every hive member's rollup. Coarse by design: a write
    // to any member busts the whole hive rollup (the rollup is hive-grained).
    'featuresConsolidated.byHive',
    'workItems.byHarness',
    'workItems.summary',
    // P-005: the observation row page, exact companion summary, and legacy kind
    // aggregate all read the issue-family projection of this base table.
    'learning.observations',
    'learning.observations.summary',
    'learning.observations.counts',
    // dependency-health-pane P-003: the graph pane's edge query resolves BOTH
    // endpoints against work_items, so a STATUS flip (a blocker going terminal)
    // or a rename changes what an edge MEANS even though work_item_deps itself
    // did not change. Bridged here as well as on work_item_deps for that reason.
    'workItems.depEdges',
    // P-006: the single-item on-demand detail read — bridged wherever byHarness is
    // so an open Detail pane live-refreshes on the same writes (state, blockers,
    // spine, plan-link) that move the list row.
    'workItems.detail',
    // The Overview stats tile's kind × state aggregate (WI-5517) — any work-item
    // write can move a count cell. delta24h (P-002) is its 24h burn-down sibling,
    // moved by exactly the same writes.
    'workItems.stats',
    'workItems.delta24h',
    'contributors.byHarness',
    'featureTimeline.byFeature',
    // scheduler.running (the live-execution view) reads work-item claims (taken_by /
    // taken_at / last_progress_at) off work_items via fleet_assignment — a claim/progress
    // flip refreshes the bee-run list (hybrid-bee-scheduler P-001).
    'scheduler.running',
    // planWorkActivity.list (plan-visibility-revamp-2026-08-23 P-001 / D-003) —
    // the PlansPane ⚒ last-work timestamps + HUD plan cards. Its aggregate is
    // max(GREATEST(updated_ts, last_progress_at)) per source_plan_slug, so any
    // work-item write can move it. Full-bust: workspace-keyed, not row-keyed.
    'planWorkActivity.list',
    // planActivity.list (P-004) — the plan dashboard's activity feed's WORK leg
    // (per-item latest movement). Full-bust: planSlug-keyed, no scope can match.
    'planActivity.list',
    // rubrics.* / scorecards.* (rubrics-tab-scorecard-ui-2026-07-09 P-002): a
    // scorecard IS an engineer_issues row (compat view over work_items — THIS base
    // table is the invalidation producer), so a newly filed grading refreshes the
    // Rubrics-tab rollup, the per-rubric history, and the trend. Coarse by design:
    // any work-item write busts them; rubric-graded reads are cheap + low-rate.
    'rubrics.list',
    'scorecards.list',
    'scorecards.summary',
    'rubrics.trend',
  ],

  // dependency-health-pane P-003 — the FIRST bridge this table has ever had.
  // `work_item_deps` carries the blocks-graph the Work-tab dependency pane renders,
  // and until this entry existed an edge write (link, unlink, promotion sync,
  // backfill) invalidated NOTHING: the pane would have gone stale until an
  // unrelated work_items write happened to bust its sibling query. Every writer
  // reaches this table through syncWorkItemDepEdges / the mirror path, so one
  // coarse entry covers them all.
  'harness_shared.work_item_deps': ['workItems.depEdges'],
  // P-011 — the first-class spec-clause substrate behind workItems.behaviorContract.
  // REVISING a clause is precisely the event an open contract panel must not miss: without
  // these bridges the panel would keep asserting coverage at a superseded revision, which
  // is the exact failure the plan exists to end. Full-bust — none of these is keyed by a
  // surrogate PK the bridge could scope on, and the query is only ever mounted while a
  // human has the section open (useSyncQuery `enabled`), so the bust costs nothing otherwise.
  // `plans.specCoverage` (the plan-surface census) shares the clause tables for the same
  // reason: a clause revised after its evidence was recorded is exactly the transition
  // that flips its verdict from satisfied to spec_proof_stale.
  // `plans.acceptanceGate` rides the same tables because the census is one of its five
  // check families — a clause revised after its evidence was recorded is what flips the
  // whole gate to spec_proof_stale, not just the census panel.
  // `workItems.specAdequacy` (the rubric/testing gate read) rides every one of these: the
  // gate selects clauses at their CURRENT revision, so a revision is what moves its verdict
  // from checked to blocked, and an open panel that missed it would tell a human a close is
  // clear when the gate would now refuse it.
  'harness_shared.plan_spec_clauses': [
    'workItems.behaviorContract',
    'workItems.specAdequacy',
    'plans.specCoverage',
    'plans.acceptanceGate',
  ],
  'harness_shared.plan_spec_clause_revisions': [
    'workItems.behaviorContract',
    'workItems.specAdequacy',
    'plans.specCoverage',
    'plans.acceptanceGate',
  ],
  'harness_shared.work_item_spec_revision_edges': ['workItems.behaviorContract', 'workItems.specAdequacy'],
  // The OTHER half of the freshness verdict: recording evidence at the current revision is
  // what CLEARS a stale-proof refusal, so an open census panel must not miss it either.
  // The adequacy gate reads these bindings directly to grade every criterion it rates, so
  // recording evidence is precisely what flips its blocker to a pass.
  'harness_shared.spec_evidence_bindings': ['plans.specCoverage', 'plans.acceptanceGate', 'workItems.specAdequacy'],
  // Compat view over work_items (post-374) — see the work_items producer above.
  'harness_shared.harness_features_consolidated': [
    'featuresConsolidated.bySlug',
    // P-007: single-feature on-demand detail (carries `summary` dropped from bySlug).
    'featuresConsolidated.detail',
    'featuresConsolidated.byPlanSlug',
    'featuresConsolidated.byHive',
    'workItems.byHarness',
    'workItems.summary',
    // P-006: the single-item on-demand detail read — bridged wherever byHarness is
    // so an open Detail pane live-refreshes on the same writes (state, blockers,
    // spine, plan-link) that move the list row.
    'workItems.detail',
    'workItems.stats',
    'workItems.delta24h',
    'contributors.byHarness',
    'featureTimeline.byFeature',
    'scheduler.running',
    // P-011 documentary mirror of the work_items producer above. This key is a
    // compat VIEW (COVERAGE_EXEMPT), but list and summary stay paired here too.
    'designFeatures.byHarness',
    'designFeatures.summary',
    // WI-7232: single-feature on-demand detail (carries `summary` dropped from byHarness).
    'designFeatures.detail',
  ],
  'harness_shared.harness_issues_consolidated': ['issuesConsolidated.bySlug'],
  // engineer_issues = the issue-family compat view over work_items (post-374; the base
  // table is the real producer above).
  'harness_shared.engineer_issues': [
    'workItems.byHarness',
    'workItems.summary',
    'workItems.detail',
    'workItems.stats',
    'workItems.delta24h',
  ],
  // coord_links = the rel='blocks' feature/work-item blocking edge table (EI-1/D-027,
  // the single source of truth for blocking) + the rel='implements' plan↔work-item
  // ledger edges. A blocks-edge add/remove is the single most important
  // READINESS-changing mutation — it flips a work-item between ready/blocked — yet the
  // table emitted NO change-notify before caching-layer-tag-eca P-013 (mig-396 attaches
  // emit_change_notify here). Mapping it makes a blocker change live-refresh the
  // work-items grid (blocked/ready badges) AND brings the table under the cache-tag
  // coverage guard. Coarse by design: the row trigger fires on ALL rels (implements /
  // relates too), so an implements write also busts workItems.byHarness — harmless +
  // bus-deduped at coord_links's low write rate (~30/hr).
  'harness_shared.coord_links': [
    'workItems.byHarness',
    'workItems.summary',
    // P-006: the single-item on-demand detail read — bridged wherever byHarness is
    // so an open Detail pane live-refreshes on the same writes (state, blockers,
    // spine, plan-link) that move the list row.
    'workItems.detail',
    // Scorecard history rows surface outbound links and rubrics.trend excludes
    // revises-linked samples. The paired summary shares their invalidation set
    // so row/count evidence converges in the same cycle.
    'scorecards.list',
    'scorecards.summary',
    'rubrics.trend',
    'conversations.questionsList',
    'conversations.questionDetail',
    // WI-6182: the Retain strip counts only issue rows carrying the
    // papercusp-improvement topic edge, so an edge add/remove is visible data.
    'learning.retain',
  ],
  'harness_shared.agent_runs_consolidated': [
    'agentRunsConsolidated.bySlug',
    'agentRunsConsolidated.summary',
    'agentRunsConsolidated.recent',
    'featureTimeline.byFeature',
  ],
  // The agentRunsConsolidated.* rows JOIN spawned_agents for the run outcome
  // (spawnStatus/exitCode/errorMessage/sessionId — adv-harness-tab-migration
  // P-023), so an outcome flip must re-fire those queries too. The trigger is
  // column-targeted (migration 213) so heartbeat writes don't spam this.
  // workItems.byHarness joins the latest spawn per feature (spine position).
  'harness_shared.spawned_agents': [
    'agentRunsConsolidated.bySlug',
    'agentRunsConsolidated.summary',
    'agentRunsConsolidated.recent',
    'workItems.byHarness',
    'workItems.summary',
    // P-006: the single-item on-demand detail read — bridged wherever byHarness is
    // so an open Detail pane live-refreshes on the same writes (state, blockers,
    // spine, plan-link) that move the list row.
    'workItems.detail',
    'fleetAssignments.byHarness',
    'advRoster.list',
    // sidebar.fleetCups reads the SAME fleet_assignment view as
    // fleetAssignments.byHarness, so a spawn/claim/presence flip must push the
    // Swarm sidebar's "Bees" cells too (else they stay stale until next
    // interaction). Bridged wherever fleetAssignments.byHarness is.
    'sidebar.fleetCups',
    // hiveRoster.byHive (presence-v2 P-006 fold) reads spawned_agents for the
    // Tier-1 model tier; an outcome/model flip re-fires it too. byHarness (P-007,
    // the MemberWorkPanel repoint) is the same fold keyed by harness→hive.
    'hiveRoster.byHive',
    'hiveRoster.byHarness',
    // scheduler.running resolves a bee run's holder liveness through the nursery
    // identity aliases (the fleet_assignment view), so a spawn status/heartbeat flip
    // moves a run between progressing/alive/dead.
    'scheduler.running',
    'evals.benchRunLive',
  ],
  // usage.spend (overview-tab-expansion P-003): the Overview Spend tile's 1h/24h
  // headline rides the same append-heavy sweep as benchRunLive — synthesized
  // `.changed` per tick, never per-row notify on this high-write telemetry log.
  'harness_shared.agent_usage_samples': [
    'evals.benchRunLive',
    'usage.spend',
    // GOAL mode's spend meters sum this table over each goal's linked projects
    // (goal-mode-2026-08-07 P-017), so a usage write is exactly when they are wrong.
    'goals.list',
    'goals.detail',
    // The Learning tab's header spend chip (scout/gym/llm-testing cost, WI-39501)
    // rides the same synthesized sweep tick; its pause/resume half is invalidated
    // explicitly by routines:group-set.
    'learning.loopControl',
  ],

  // ── Learning-tab push audit stragglers (WI-6182) ─────────────────
  // These are low-churn content/state relations. Migration 1108 attaches the
  // generic change trigger (with a learning-row predicate for routines), so a
  // raw-SQL or federated writer cannot bypass the same push contract.
  'harness_shared.scout_lens_weights': ['learning.retain'],
  'harness_shared.cup_keeper_instances': ['learning.apiary'],
  'harness_shared.cup_keeper_runs': ['learning.apiary'],
  'harness_shared.cup_keeper_scores': ['learning.apiary'],
  'harness_shared.pot_eval_instances': ['learning.hiveEvalTrend'],
  'harness_shared.pot_eval_runs': ['learning.hiveEvalTrend'],
  'harness_shared.pot_eval_scores': ['learning.hiveEvalTrend'],
  'harness_shared.scout_cycle_stage_artifacts': ['learning.analyze', 'learning.analyzeCycle'],
  'harness_shared.scout_ticks': ['learning.analyze', 'learning.analyzeCycle', 'learning.frontier'],
  'harness_shared.scout_routed_ideas': [
    'learning.analyze',
    'learning.analyzeCycle',
    'learning.scoutDrafts',
    'learning.dream',
  ],
  'harness_shared.dream_runs': ['learning.dream'],
  'harness_shared.experiment_runs': ['learning.experiments', 'learning.dream'],
  'harness_shared.learning_governor_loops': ['learning.frontier', 'learning.dream'],
  'harness_shared.calibration_predictions': ['learning.frontier'],
  'harness_shared.regret_findings': ['learning.frontier'],
  'harness_shared.transfer_lessons': ['learning.frontier'],
  'harness_shared.prompt_ablation_runs': ['learning.frontier'],
  'harness_shared.routines': ['learning.frontier', 'harnessPrs.byHarness', 'harnessPrs.detail'],
  'harness_shared.bench_runs': ['evals.benchRuns', 'evals.benchRun', 'evals.benchRunLive'],
  'harness_shared.bench_run_tasks': ['evals.benchRun', 'evals.benchRunLive'],
  // fleetAssignments.byHarness (progress-tab-agents-convergence P-001) reads the
  // fleet_assignment view = presence + plan-item claims + work-item claims.
  // coord_presence fires on heartbeats too — the 90s (name,args) dedupe window
  // bounds the refetch rate; claim flips are what actually matter.
  // network.board reads live-agent counts off the same fleet view, so a
  // presence/claim flip refreshes its tier 1–3 liveAgents too (90s dedupe bounds
  // the heartbeat churn; grant/ask/beacon changes ride explicit
  // notifySyncInvalidate('network.board', {}) from their writers + the 60s
  // consumer safety-net).
  // dev.coordPresence is the live-agents roster (the Mod+U PresenceRail +
  // /coord dashboard read it): a heartbeat/intent/claim write must push the
  // roster too, not just the fleet view (shared-hive-collaboration P-006 — the
  // rail was a 30s poll before; SSE push replaces it).
  'harness_shared.coord_presence': [
    // P-030: foreign session intent/plan context. This table already rides the
    // heartbeat-deduped bridge; adding a consumer does not add another producer.
    'conversations.contextProjection',
    'fleetAssignments.byHarness',
    'sidebar.fleetCups', // same fleet_assignment view — keep the Swarm sidebar live
    'network.board',
    'dev.coordPresence',
    'agentDetail.byOwner',
    // WI-6961: the ORDERS half of the same session popup — buildCarryBrief reads
    // presence, so the panel goes stale on exactly the writes agentDetail does.
    'agentOrders.byOwner',
    // popup-agent-state-coverage-2026-08-18 P-002: the FLEET-PEERS half of that
    // same popup. Presence is not incidental to it — it IS its subject: every
    // per-member marker the pane exists to show (dormant / spinning / throttled
    // / coordHook) is derived from presence rows, so a presence write is a real
    // change in what the pane says, not the heartbeat churn that keeps
    // agentOrders.byOwner off this list. The query only runs while a LEADER's
    // popup is open, and the 90s (name,args) dedupe bounds the refetch rate.
    'agentLeaderBrief.byOwner',
    'advRoster.list',
    // hiveRoster.byHive (presence-v2 P-006) folds coord_presence + the fleet
    // work-detail; a presence/intent/claim/last_active write refreshes it too.
    // byHarness (P-007) is the same fold keyed by harness→hive.
    'hiveRoster.byHive',
    'hiveRoster.byHarness',
    // dev.assignableMembers (P-016) unions live presence + offline members — a
    // presence flip moves a person between the online/offline groups in the picker.
    'dev.assignableMembers',
    // scheduler.running derives each bee run's idle/blocked reason from the holder's
    // presence liveness — a heartbeat/intent flip refreshes the live-execution view.
    'scheduler.running',
  ],
  // hive_members (admission) is the offline half of the @-assign picker — a new
  // admitted member becomes assignable the moment they're admitted (P-016).
  // EI-19304902443341820: `p2p.devices` renders the pot's device/member roster straight off this
  // table but was not listed, so a device joining or leaving never pushed to it. Low-churn table,
  // so the added fan-out is negligible. Found by the resolver→table coverage guard.
  'harness_shared.pot_members': ['dev.assignableMembers', 'p2p.devices'],
  // external-app-access P-010 (D-025): Settings → Remote access lists every phone, app key and
  // service key and shows the workspace switch. Migration 1264 attaches the shared change-notify
  // trigger to both tables, so every writer (not only the screen's routes) refreshes an open page.
  'harness_shared.connected_apps': ['remoteAccess.overview'],
  'harness_shared.connected_app_access_settings': ['remoteAccess.overview'],
  // P-510: the host-local foreign-work registry drives the Settings page's
  // lifecycle view. Migration 985 attaches the shared change-notify trigger;
  // full-bust is appropriate because the query is one low-volume workspace fold.
  'harness_shared.p2p_foreign_workspaces': ['p2p.foreignWorkspaces'],
  // pot_settings backs the owner-steering:* keys (queen-steering-panel B-01/C-1)
  // and per-Pot beacon consent. Steering remains a workspace-wide fold; beacon
  // consent is keyed by the changed row's natural harness_slug so only that pot's
  // PotBeaconToggle refreshes after a federated write.
  // potIntegration.settings (pot-review-integration-mode P-017, EI-25188362216785598) reads the
  // pot's integration mode; its args are the HARNESS slug, not the pot home slug, so it full-busts
  // (only mounted settings sections re-read).
  'harness_shared.pot_settings': [
    'hive.steering',
    'learning.dream',
    { name: 'hive.beaconConsent', scope: potHomeSlugScope },
    'potIntegration.settings',
  ],
  'harness_shared.feature_claims': [
    'fleetAssignments.byHarness',
    'sidebar.fleetCups',
    'network.board',
    'hiveRoster.byHive',
    'hiveRoster.byHarness',
    'scheduler.running',
  ],
  'harness_shared.claim_audit': [
    'fleetAssignments.byHarness',
    'sidebar.fleetCups',
    'hiveRoster.byHive',
    'hiveRoster.byHarness',
    'scheduler.running',
  ],
  // cup_claim_specs (né bee_claim_specs, cup-lexicon-full-rename-2026-07-09 P-009
  // Phase 2 / WI-3954) backs the per-run claim-spec specId@revision shown by the
  // live-execution view (scheduler.running) — a Queen set_claim_spec re-steer bumps the
  // revision a running bee shows (hybrid-bee-scheduler P-001 / D-007).
  'harness_shared.cup_claim_specs': ['scheduler.running'],
  // (coord_event_log's entry lives above, merged — see the note there on why this
  // key must never be re-declared.)
  // coord_open_escalations (355-coord-open-escalations-projection.sql) is the
  // small open-escalation projection plans:attention's listEscalations source
  // reads — NOT the same table as coord_event_log above, and (until mig 633)
  // had no reactive trigger at all, so a new/resolved escalation never pushed
  // a live `plans.attention` refresh regardless of plan_slug (EI-14209: the
  // Inbox pane needed a manual reload). Bare full-bust target, same shape as
  // harness_plans -> plans.attention below.
  'harness_shared.coord_open_escalations': [
    'plans.attention',
    'plans.attentionItem',
    'plans.attentionCounts',
    // An escalation arriving/resolving changes which `escalation:<msgId>` refs
    // resolve — the exact rows plans.attentionRefs carries (D-031).
    'plans.attentionRefs',
  ],
  'harness_shared.harness_snapshots_consolidated': ['snapshotsConsolidated.bySlug'],

  // ── Insights / activity ledger (v5 addendum 3) ──────────────────
  // No camelCase query names yet — Insights tab + activity-feed reads
  // are P-073+ work. Mapped here in advance so trigger events have a
  // home the moment the consumers land; until then, the trigger fires
  // events with no matching subscriber (harmless no-op, dedupe handles).
  'harness_shared.contributor_usage_events': ['contributorUsageEvents.byHarness', 'contributors.byHarness'],
  'harness_shared.insights_first_visit': ['insightsFirstVisit.byHarness'],
};

/** The PG-trigger payload shape (`emit_change_notify`, migrations 368 + 507). */
export interface TriggerEventArgs {
  workspace_id?: unknown;
  op?: unknown;
  /** The changed row's `id` PK; absent (JSON null) for id-less tables. */
  id?: unknown;
  /** Natural-key fallback (mig 507, EI-7433) for id-less tables — currently
   *  only `harness_plans` carries this column; JSON null for every other
   *  triggered table. */
  plan_slug?: unknown;
  /** Natural-key fallback for per-Pot settings (mig 507 follow-up). */
  harness_slug?: unknown;
}

/** A bridged invalidation target: a bare name (full-bust) or name + scoped
 *  args. Mirrors `@papercusp/sync/server`'s `BridgeTarget` (kept local so this
 *  module stays import-light; the bus accepts `string | { name, args }`). */
export type BridgedInvalidation = string | { name: string; args: Record<string, unknown> };

/** Coerce the trigger payload's `id` to a non-empty string, else undefined.
 *  Postgres `to_jsonb(row)->'id'` yields a JSON null for id-less tables and a
 *  JSON number/string otherwise; either form normalizes here. */
function rowIdOf(args: TriggerEventArgs | undefined): string | undefined {
  const raw = args?.id;
  if (raw == null) return undefined;
  if (typeof raw === 'string') return raw.length > 0 ? raw : undefined;
  if (typeof raw === 'number' || typeof raw === 'bigint') return String(raw);
  return undefined;
}

function workspaceIdOf(args: TriggerEventArgs | undefined): string | undefined {
  const raw = args?.workspace_id;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** Natural-key fallback (mig 507, EI-7433): non-empty string `args.plan_slug`,
 *  else undefined. Absent (JSON null) for every table but `harness_plans`. */
function planSlugOf(args: TriggerEventArgs | undefined): string | undefined {
  const raw = args?.plan_slug;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** Natural-key scope for Pot-home keyed queries. The resolver consumer calls its
 * argument `potId`, while the shared table calls the same identity `harness_slug`.
 * Hoisted because TABLE_TO_QUERY_NAMES references it during module initialization. */
function potHomeSlugScope(potHomeSlug: string): Record<string, unknown> | null {
  return potHomeSlug ? { potId: potHomeSlug } : null;
}

/** Natural-key fallback (mig 507 follow-up): pot_settings has no surrogate id,
 * so its harness_slug identifies the Hive-home row for scoped invalidation. */
function potHomeSlugOf(args: TriggerEventArgs | undefined): string | undefined {
  const raw = args?.harness_slug;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** Scope builder for `plans.get` (EI-7433) — the resolved key IS the plan
 *  slug (harness_plans has no `id`, so {@link queryNamesForTriggerEvent}
 *  resolves the natural-key fallback into the same "key" slot `resolveBridgeTarget`
 *  passes as this function's first argument). Returns a SUBSET of the
 *  consumer's real args (`{ slug, mode, harness? }`) — see the file-top note
 *  on why a matching subset is sufficient for `invalidateQueries`.
 *
 *  A hoisted `function` declaration (not a `const` arrow) — `TABLE_TO_QUERY_NAMES`
 *  above references it and is itself a module-top `const`, so a `const` here
 *  would TDZ-fail at import time. */
function planSlugScope(slug: string): Record<string, unknown> | null {
  return slug ? { slug } : null;
}

/** Detail queries whose consumer key is exactly `{ id }`. Hoisted because the
 * table registry above references it during module initialization. */
function idScope(id: string): Record<string, unknown> | null {
  return id ? { id } : null;
}

/**
 * Resolve ONE mapped target against an event's row id + workspace.
 *
 *   - bare string → bare name (FULL-BUST), unchanged behavior.
 *   - `{ name, scope }` → SCOPED `{ name, args }` when `rowId` is present AND
 *     `scope(rowId, workspaceId)` returns a key object; otherwise the bare
 *     name (full-bust fallback — no id, or scope opted out for this event).
 *
 * Pure + exported so the scoping decision is unit-testable directly against a
 * `{ name, scope }` target (the live registry has only full-bust entries yet).
 */
export function resolveBridgeTarget(
  target: QueryNameTarget,
  rowId: string | undefined,
  workspaceId: string | undefined,
): BridgedInvalidation {
  if (typeof target === 'string') return target;
  if (rowId !== undefined) {
    const scopedArgs = target.scope(rowId, workspaceId);
    if (scopedArgs !== null) return { name: target.name, args: scopedArgs };
  }
  return target.name;
}

/**
 * The trigger-LESS append-heavy LOG tables the debounced change-detector must POLL
 * (append-heavy-invalidator.ts; data-sync-push-completion P-005/D-012). These are MAPPED above
 * but INTENTIONALLY carry NO per-row emit_change_notify trigger — a per-row pg_notify on a
 * high-write log is the notify-storm anti-pattern (mig 376 drops it; cache-tag-trigger-coverage's
 * COVERAGE_EXEMPT documents it). The detector MAXes a monotonic column per tick and synthesizes a
 * `<table>.changed` invalidation when it advances, so consumers push-update WITHOUT the per-row storm.
 *
 * RELATIONSHIP to cache/debounced-invalidate.ts (cache-expensive-tool-reads P-008): that module's
 * `APPEND_HEAVY_TABLES` Set is the CONSUMER-side cache coalescer — it debounces L1 cache-tag bumps
 * WHEN a `<table>.changed` fires. This list is the PRODUCER side — who FIRES `.changed` for the
 * trigger-less tables. They compose automatically: a synthesized `.changed` flows through sync-sse's
 * bridge → emitSystemEvent → the cache ECA's coalescer AND → the client query-name push. This list
 * is a strict SUBSET of that Set (it excludes coord_event_log, which already has a real mig-275
 * trigger, so it is NOT polled). A drift-guard test asserts the subset relation.
 *
 * `changeKey` = the MONOTONIC-on-insert bigint column the detector MAXes to detect new rows. NOT
 * every table has a usable integer `id`: audit_log's `id` is TEXT, and agent_runs_consolidated /
 * harness_hook_logs have NO `id` column — they carry a bigint epoch `ts` instead. (Found live: the
 * first cut assumed `id` everywhere and errored on 3 of 6.) All changeKeys are bigint so the sweep
 * compares them uniformly via BigInt(). Detection catches new rows; a pure UPDATE that doesn't
 * advance changeKey lags to the next insert / 180s drift-repair.
 */
export interface AppendHeavyTableSpec {
  readonly table: string;
  readonly changeKey: string;
}
export const APPEND_HEAVY_POLL_SPECS: readonly AppendHeavyTableSpec[] = [
  { table: 'audit_log', changeKey: 'ts' }, // id is TEXT — use the bigint ts
  { table: 'agent_runs_consolidated', changeKey: 'ts' }, // no id column
  { table: 'user_actions', changeKey: 'id' },
  { table: 'harness_hook_logs', changeKey: 'ts' }, // no id column
  { table: 'toast_log', changeKey: 'id' },
  { table: 'feature_audit_consolidated', changeKey: 'id' },
  // WI-6182: already mapped above but previously omitted from the producer
  // list, so its consumers had no event at all. id is the identity PK and
  // advances once per governed model-call sample.
  { table: 'agent_usage_samples', changeKey: 'id' },
] as const;

/**
 * Given a trigger-event name like `harness_shared.<table>.changed` (+ the
 * trigger's `args` payload), return the bridged invalidation targets. See
 * {@link resolveBridgeTarget} for the per-target scope/full-bust decision.
 *
 * Returns an empty array for unknown tables / malformed names. Pure —
 * caller emits the synthesized events.
 */
export function queryNamesForTriggerEvent(
  triggerEventName: string,
  triggerArgs?: TriggerEventArgs,
): readonly BridgedInvalidation[] {
  // Strip the `.changed` suffix.
  if (!triggerEventName.endsWith('.changed')) return [];
  const tableKey = triggerEventName.slice(0, -'.changed'.length);
  const targets = TABLE_TO_QUERY_NAMES[tableKey];
  if (targets === undefined) return [];

  // EI-7433: prefer the true row PK; fall back to a natural-key (mig 507)
  // for id-less tables (harness_plans.plan_slug or pot_settings.harness_slug).
  // Whichever is
  // present becomes the "key" resolveBridgeTarget hands to a target's
  // `scope` builder — a target's own scope function decides what it means
  // (an id-keyed scope treats it as a PK; planSlugScope treats it as a slug).
  const rowId = rowIdOf(triggerArgs) ?? planSlugOf(triggerArgs) ?? potHomeSlugOf(triggerArgs);
  const workspaceId = workspaceIdOf(triggerArgs);
  return targets.map((t) => resolveBridgeTarget(t, rowId, workspaceId));
}

/** Test-only — enumerate every camelCase name covered by the bridge. */
export function allBridgedQueryNames(): string[] {
  const set = new Set<string>();
  for (const targets of Object.values(TABLE_TO_QUERY_NAMES)) {
    for (const t of targets) set.add(typeof t === 'string' ? t : t.name);
  }
  return Array.from(set).sort();
}
