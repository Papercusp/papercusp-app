/**
 * Route registry barrel.
 *
 * Every `defineTool` module is side-effect-free and `export default`s
 * either one `RouteDefinition` or an array of them (a route file that
 * serves multiple methods on one path — e.g. GET + OPTIONS). This barrel
 * imports them all and flattens into `ALL_ROUTES`.
 *
 * Add a route: drop a file under `routes/<family>/<name>.ts`, then add a
 * line here. Mirrors the `lib/agent-tools/index.ts` barrel pattern.
 *
 * R1 — 3 pilots. R4/R5 grow this to all 243 endpoints.
 */
import type { ZodTypeAny } from 'zod';
import type { RouteDefinition } from '../define-route';

import desktopVersion from './desktop/version';
import deployFrameView from './deploy/frame-view';
import deployFrames from './deploy/frames';
import deployLocalDesktops from './deploy/local-desktops';
import deployLocalDesktopThumbnail from './deploy/local-desktop-thumbnail';
import discoveryPots from './discovery/pots';
import discoveryFederationStatus from './discovery/federation-status';
import discoveryPotMeta from './discovery/pot-meta';
import discoverySetPot from './discovery/set-pot';
import discoveryBeaconConsent from './discovery/beacon-consent';
import discoveryJoinInvite from './discovery/join-invite';
import discoveryJoinPot from './discovery/join-pot';
import githubSearchRepos from './github/search-repos';
import deployVncSession from './deploy/vnc-session';
import flagsWebhook from './flags/webhook';
import flagsBootstrap from './flags/bootstrap';
import flagsStream from './flags/stream';
import flagsSet from './flags/set';
import workScopeRoutes from './work-scope/set';
import flagsTestingFeatures from './flags/testing-features';
import flagsPreset from './flags/preset';
import flagsDashboardUrl from './flags/dashboard-url';
import operatorStateSnapshot from './operator/state-snapshot';
import operatorSettingsByKey from './operator/settings-by-key';
import operatorRateLimitConfig from './operator/rate-limit-config';
import operatorConversations from './operator/conversations';
import operatorConversationTurns from './operator/conversation-turns';
import operatorCardResponse from './operator/card-response';
import operatorSilenceNudge from './operator/silence-nudge';
import operatorRunCancel from './operator/run-cancel';
import operatorPapercupInput from './operator/papercup-input';
import operatorPapercupOutput from './operator/papercup-output';
import operatorTurnAnswer from './operator/turn-answer';
import operatorEventsEmit from './operator/events-emit';
import operatorHiveSteering from './operator/hive-steering';
import backupsIndex from './backups/index';
import backupsBrokenList from './backups/broken-list';
import backupsFailures from './backups/failures';
import backupsMaintenance from './backups/maintenance';
import backupsRollback from './backups/rollback';
import backupsServer from './backups/server';
import backupsVerify from './backups/verify';
import backupsDestination from './backups/destination';
import backupsEvents from './backups/events';
import backupsHealthcheck from './backups/healthcheck';
import backupsPromote from './backups/promote';
import backupsRestore from './backups/restore';
import backupsSnapshots from './backups/snapshots';
import harnessProjects from './harness/projects';
// learning-packs-2026-06-11 P-009/P-010 — the Learnings view's pack management:
import knowledgePacksRoutes from './knowledge-packs';
import harnessMembership from './harness/membership';
import harnessJoinLink from './harness/join-link';
// share-finalize / binding-resolve / cupboard-publish (the per-harness
// ShareWizard routes) were retired — comb-retire-per-harness-sharing-2026-06-11.
import harnessBindingClaim from './harness/binding-claim';
import harnessClaimStatus from './harness/claim-status';
import potPolicy from './pot/policy-set';
import potRateState from './pot/rate-state';
import harnessContributors from './harness/contributors';
import harnessContributorUsage from './harness/contributor-usage';
import harnessActivity from './harness/activity';
import harnessInsights from './harness/insights';
import harnessInsightsFirstVisit from './harness/insights-first-visit';
import harnessClaimAttempts from './harness/claim-attempts';
import harnessBootstrapProgress from './harness/bootstrap-progress';
import harnessFeatureQueue from './harness/feature-queue';
import harnessClaimFeature from './harness/claim-feature';
import harnessClobberStream from './harness/clobber-stream';
import harnessWorkingSet from './harness/working-set';
import usersByGithubId from './users/by-github-id';
import usersByLogin from './users/by-login';
import usersViewer from './users/viewer';
import harnessPrs from './harness/prs';
import harnessPrReviewerSettings from './harness/pr-reviewer-settings';
import harnessProjectDocs from './harness/project-docs';
import harnessDocs from './harness/docs';
import harnessSync from './harness/sync';
import cupboard from './cupboard';
import cupboardInstallPlugin from './cupboard-install-plugin';
import cupboardInstallDeps from './cupboard-install-deps';
import cupboardPublishPlugin from './cupboard-publish-plugin';
import cupboardInstallBlueprint from './cupboard-install-blueprint';
import cupboardPublishBlueprint from './cupboard-publish-blueprint';
import cupboardInstallTemplate from './cupboard-install-template';
import cupboardInstallTheme from './cupboard-install-theme';
import cupboardPublishTemplate from './cupboard-publish-template';
import cupboardInstallApp from './cupboard-install-app';
import harnessSpec from './harness/spec';
import harnessBlueprintParams from './harness/blueprint-params';
import harnessWorkItems from './harness/work-items';
import promptStudio from './prompt-studio';
import harnessDiscord from './harness/discord';
import harnessIntegrationMode from './harness/integration-mode';
import harnessAssertion from './harness/assertion';
import harnessTextViews from './harness/text-views';
import harnessRuns from './harness/runs';
import harnessStandaloneViews from './harness/standalone-views';
import harnessProjectStats from './harness/project-stats';
import harnessStateViews from './harness/state-views';
import harnessNotesDiff from './harness/notes-diff';
import harnessFeatureViews from './harness/feature-views';
import harnessFeatures from './harness/features';
import harnessEndpoint from './harness/endpoint';
import harnessAdaptiveTelemetry from './harness/adaptive-telemetry';
import harnessProposalsViews from './harness/proposals-views';
import harnessProposals from './harness/proposals';
import harnessScoperActions from './harness/scoper-actions';
import harnessArchives from './harness/archives';
import harnessSupervisorActions from './harness/supervisor-actions';
import harnessOrchestrationActions from './harness/orchestration-actions';
import harnessTests from './harness/tests';
import harnessTesting from './harness/testing';
import harnessUsage from './harness/usage';
import harnessAgents from './harness/agents';
import harnessScreenshots from './harness/screenshots';
import harnessSnapshots from './harness/snapshots';
import harnessHooks from './harness/hooks';
import harnessConfigFiles from './harness/config-files';
import harnessSkillsNotes from './harness/skills-notes';
import harnessPrompts from './harness/prompts';
import harnessBrainstorm from './harness/brainstorm';
import harnessCompletionRefRecheck from './harness/completion-ref-recheck';
import harnessGit from './harness/git';
import harnessProcessControl from './harness/process-control';
import harnessReviews from './harness/reviews';
import harnessMemory from './harness/memory';
import harnessPhases from './harness/phases';
import harnessIssues from './harness/issues';
import harnessStreams from './harness/streams';
import harnessStatus from './harness/status';
import harnessProjectHistory from './harness/project-history';
import harnessLogHistory from './harness/log-history';
import harnessSpawn from './harness/spawn';
import harnessBootstrapFromTemplate from './harness/bootstrap-from-template';
import harnessPromote from './harness/promote';
import harnessAllKpis from './harness/all-kpis';
import harnessFile from './harness/file';
import harnessManifest from './harness/manifest';
import harnessIntelArtifacts from './harness/intel-artifacts';
import harnessIntelSpawnTree from './harness/intel-spawn-tree';
import harnessBranchActions from './harness/branch-actions';
import harnessBranchActionRun from './harness/branch-action-run';
import harnessBranchActionStream from './harness/branch-action-stream';
import harnessBranchActionByNameRun from './harness/branch-action-by-name-run';
import uiPresence from './ui/presence';
import uiIntentsStream from './ui/intents-stream';
import uiIntentResult from './ui/intent-result';
import zeroHarnessSse from './zero-harness/sse';
import zeroHarnessRestQuery from './zero-harness/rest-query';
import agentToolsCatchall from './agent-tools/catchall';
import pluginRuntimeCatchall from './plugin-runtime/catchall';
import transport from './transport/index';
import internalLogEvent from './internal/log-event';
import internalRunChunk from './internal/run-chunk';
import internalDecisionEvent from './internal/decision-event';
import internalEscalationEvent from './internal/escalation-event';
import internalArchiveEvent from './internal/archive-event';
import internalCheckpointEvent from './internal/checkpoint-event';
import internalFeatureDebugNoteEvent from './internal/feature-debug-note-event';
import internalHookLogEvent from './internal/hook-log-event';
import internalIdentitySnapshot from './internal/identity-snapshot';
import internalPrEvent from './internal/pr-event';
import internalSkillSnapshot from './internal/skill-snapshot';
import internalSmokeTestEvent from './internal/smoke-test-event';
import internalTestSnapshot from './internal/test-snapshot';
import pluginsEnabled from './plugins/enabled';
import pluginsManifest from './plugins/manifest';
import pluginsGlobal from './plugins/global';
import pluginsGrants from './plugins/grants';
import pluginsInvoke from './plugins/invoke';
import pluginsTools from './plugins/tools';
import pluginsUninstall from './plugins/uninstall';
import pluginsEnable from './plugins/enable';
import pluginsConfig from './plugins/config';
import pluginsConfigs from './plugins/configs';
import pluginsHostRuntimeStatus from './plugins/host-runtime-status';
import pluginsHostEvents from './plugins/host-events';
import pluginsHostQuery from './plugins/host-query';
import pluginsHostInvoke from './plugins/host-invoke';
import pluginsHostRefresh from './plugins/host-refresh';
import pluginsContributions from './plugins/contributions';
import pluginsIframeEntry from './plugins/iframe-entry';
import pluginsUpdates from './plugins/updates';
import pluginsList from './plugins/list';
import pluginsInstalled from './plugins/installed';
import pluginsRuntimeStatus from './plugins/runtime-status';
import pluginsRuntimeInvokeAction from './plugins/runtime-invoke-action';
import pluginsRuntimeFireEvent from './plugins/runtime-fire-event';
import pluginsCatchall from './plugins/catchall';
import agentMcp_agents from './agent-mcp/agents';
import agentMcp_consoleLaunch from './agent-mcp/console-launch';
import agentMcp_consoleLaunchBridge from './agent-mcp/console-launch-bridge';
import agentMcp_consoleResolve from './agent-mcp/console-resolve';
import agentMcp_consoleRecord from './agent-mcp/console-record';
import agentMcp_bootstrapSu from './agent-mcp/bootstrap-su';
import agentMcp_bootstrapSuPersonaRefresh from './agent-mcp/bootstrap-su-persona-refresh';
import agentMcp_recoveryAuditReconcile from './agent-mcp/recovery-audit-reconcile';
import agentMcp_bootstrapRole from './agent-mcp/bootstrap-role';
import agentMcp_sessionRecoveryBrief from './agent-mcp/session-recovery-brief';
import agentMcp_contextEpochBump from './agent-mcp/context-epoch-bump';
import agentMcp_turnEndDirectiveCheck from './agent-mcp/turn-end-directive-check';
import agentMcp_restrictedEgressCheck from './agent-mcp/restricted-egress-check';
import agentMcp_turnStartMemory from './agent-mcp/turn-start-memory';
import agentMcp_midTurnContext from './agent-mcp/mid-turn-context';
import agentMcp_identityHookSinks from './agent-mcp/identity-hook-sinks';
import agentMcp_rebindIdentity from './agent-mcp/rebind-identity';
import agentMcp_identityManagement from './agent-mcp/identity-management';
import agentMcp_decisions from './agent-mcp/decisions';
import agentMcp_delegateChat from './agent-mcp/delegate-chat';
import agentMcp_operatorHindsight from './agent-mcp/operator-hindsight';
import agentMcp_delegates from './agent-mcp/delegates';
import agentMcp_elAdminCreds from './agent-mcp/el-admin-creds';
import agentMcp_endPi from './agent-mcp/end-pi';
import agentMcp_events from './agent-mcp/events';
import agentMcp_ompConfig from './agent-mcp/omp-config';
import agentMcp_operatorAudit from './agent-mcp/operator-audit';
import agentMcp_operatorBudget from './agent-mcp/operator-budget';
import agentMcp_operatorCartesiaTest from './agent-mcp/operator-cartesia-test';
import agentMcp_operatorConfig from './agent-mcp/operator-config';
import agentMcp_savedPrompts from './agent-mcp/saved-prompts';
import agentMcp_operatorConverse from './agent-mcp/operator-converse';
import agentMcp_operatorConvVoice from './agent-mcp/operator-conv-voice';
import agentMcp_operatorCredentials from './agent-mcp/operator-credentials';
import agentMcp_operatorDispatch from './agent-mcp/operator-dispatch';
import agentMcp_operatorElevenlabsBootstrap from './agent-mcp/operator-elevenlabs-bootstrap';
import agentMcp_operatorElevenlabsWsInit from './agent-mcp/operator-elevenlabs-ws-init';
import agentMcp_operatorElevenlabsTest from './agent-mcp/operator-elevenlabs-test';
import agentMcp_operatorElevenlabsVoices from './agent-mcp/operator-elevenlabs-voices';
import agentMcp_operatorVoiceEngineHealth from './agent-mcp/operator-voice-engine-health';
import agentMcp_operatorVoiceProvision from './agent-mcp/operator-voice-provision';
import agentMcp_operatorElSpend from './agent-mcp/operator-el-spend';
import agentMcp_operatorElSubscription from './agent-mcp/operator-el-subscription';
import agentMcp_operatorMessageStatus from './agent-mcp/operator-message-status';
import agentMcp_operatorMultiWorkspace from './agent-mcp/operator-multi-workspace';
import agentMcp_operatorNudge from './agent-mcp/operator-nudge';
import agentMcp_operatorOpenaiTest from './agent-mcp/operator-openai-test';
import agentMcp_operatorPauseFlag from './agent-mcp/operator-pause-flag';
import agentMcp_operatorPicovoiceBootstrap from './agent-mcp/operator-picovoice-bootstrap';
import agentMcp_operatorPreferences from './agent-mcp/operator-preferences';
import agentMcp_operatorRealtimeBootstrap from './agent-mcp/operator-realtime-bootstrap';
import agentMcp_operatorStandingApprovals from './agent-mcp/operator-standing-approvals';
import agentMcp_operatorStats from './agent-mcp/operator-stats';
import agentMcp_operatorStt from './agent-mcp/operator-stt';
import agentMcp_operatorSttBootstrap from './agent-mcp/operator-stt-bootstrap';
import agentMcp_operatorSttSpend from './agent-mcp/operator-stt-spend';
import agentMcp_operatorTriggerState from './agent-mcp/operator-trigger-state';
import agentMcp_operatorTts from './agent-mcp/operator-tts';
import agentMcp_operatorTtsPreview from './agent-mcp/operator-tts-preview';
import agentMcp_operatorTtsSpend from './agent-mcp/operator-tts-spend';
import agentMcp_operatorVoicePrefs from './agent-mcp/operator-voice-prefs';
import agentMcp_provision from './agent-mcp/provision';
import agentMcp_runCommandResult from './agent-mcp/run-command-result';
import agentMcp_runCommandSse from './agent-mcp/run-command-sse';
import agentMcp_runCommand from './agent-mcp/run-command';
import agentMcp_capabilities from './agent-mcp/capabilities';
import agentMcp_runTool from './agent-mcp/run-tool';
import agentMcp_autonomyPolicySet from './agent-mcp/autonomy-policy-set';
import agentMcp_storagePrune from './agent-mcp/storage-prune';
import agentMcp_autonomyTripwireRevert from './agent-mcp/autonomy-tripwire-revert';
import agentMcp_trustSet from './agent-mcp/trust-set';
import agentMcp_p2pSettingsSet from './agent-mcp/p2p-settings-set';
import agentMcp_consultExpertRoutingSet from './agent-mcp/consult-expert-routing-set';
import agentMcp_p2pGrantSet from './agent-mcp/p2p-grant-set';
import agentMcp_p2pAllotmentSet from './agent-mcp/p2p-allotment-set';
import agentMcp_potOverrideSet from './agent-mcp/pot-override-set';
import agentMcp_spawnPi from './agent-mcp/spawn-pi';
import agentMcp_voiceDebug from './agent-mcp/voice-debug';
import agentMcp_voiceUtteranceLog from './agent-mcp/voice-utterance-log';
import agentMcp_workspaceCompanyId from './agent-mcp/workspace-company-id';
import openapiJson from './openapi-json';
import devRouteInvocations from './dev/route-invocations';
import agentConfig from './agent-config/index';
import agentConfigTest from './agent-config/test';
import credentials from './credentials/index';
import credentialsSearchProviders from './credentials/search-providers';
import agentTokensPowerUser from './agent-tokens/power-user';
import agentTokensPowerUserRefresh from './agent-tokens/power-user-refresh';
import installed from './installed/index';
import installedPrune from './installed/prune';
import oauthStart from './oauth/start';
import oauthCallback from './oauth/callback';
import oauthVerifyPaste from './oauth/verify-paste';
import publishCredentials from './publish-credentials/index';
import publishCredentialsRotate from './publish-credentials/rotate';
import miscRuntimeVintageReport from './misc/runtime-vintage-report';
import miscMemoryCanaryProbe from './misc/memory-canary-probe';
import miscDomainReadCanary from './misc/domain-read-canary';
import miscManagedTimers from './misc/managed-timers';
import miscFlagAttest from './misc/flag-attest';
import miscSubstrateHeadSnapshot from './misc/substrate-head-snapshot';
import miscSubstrateOwnCompaction from './misc/substrate-own-compaction';
import miscHealth from './misc/health';
import miscHealthReady from './misc/health-ready';
import miscHealthDeep from './misc/health-deep';
import miscToastLog from './misc/toast-log';
import miscWikiBacklinks from './misc/wiki-backlinks';
import miscProfile from './misc/profile';
import miscSecurityAdvisoriesCheck from './misc/security-advisories-check';
import miscAgentBundle from './misc/agent-bundle';
import miscTestButtonsEcho from './misc/test-buttons-echo';
import miscUpdatesManifest from './misc/updates-manifest';
import miscUpdatesHistory from './misc/updates-history';
import miscUpdatesRollback from './misc/updates-rollback';
import miscUpdatesDownload from './misc/updates-download';
import authLogin from './auth/login';
import authLogout from './auth/logout';
import authSignup from './auth/signup';
import authChangePassword from './auth/change-password';
import authMe from './auth/me';
import provisionConsent from './provision/consent';
import provisionHostCheck from './provision/host-check';
import provisionState from './provision/state';
import provisionRun from './provision/run';
import provisionStream from './provision/stream';
import desktopAgentAuthStatus from './desktop/agent-auth-status';
import desktopAgentLoginEnvelope from './desktop/agent-login-envelope';
import desktopGitIdentity from './desktop/git-identity';
import desktopLocalModelInstall from './desktop/local-model-install';
import desktopLocalModelStatus from './desktop/local-model-status';
import desktopPreflight from './desktop/preflight';
import desktopOnboardingLaunchContext from './desktop/onboarding-launch-context';
import desktopOnboardingStatus from './desktop/onboarding-status';
import desktopTutorialScript from './desktop/tutorial-script';
import desktopDocsQa from './desktop/docs-qa';
import desktopDocsAgentAsk from './desktop/docs-agent-ask';
import desktopSetupPtyCommands from './desktop/setup-pty-commands';
import desktopSetupStatus from './desktop/setup-status';
import desktopSetupWizardState from './desktop/setup-wizard-state';
import desktopTelemetryConfig from './desktop/telemetry-config';
import desktopTelemetryFlush from './desktop/telemetry-flush';
import desktopTelemetryReport from './desktop/telemetry-report';
import desktopVoiceConfig from './desktop/voice-config';
import desktopWorkspaceValidate from './desktop/workspace-validate';
import desktopInstallPapercuspFiles from './desktop/install-papercusp-files';
import desktopInstallOmpIntegration from './desktop/install-omp-integration';
import desktopBootstrapPotStart from './desktop/bootstrap-pot-start';
import { desktopGithubUser } from './desktop/github-user';
import adminBackupOrphanCleanup from './admin/backup-orphan-cleanup';
import adminCommands from './admin/commands';
import adminDeployAccountsList from './admin/deploy-accounts-list';
import adminDeployAccountsRegister from './admin/deploy-accounts-register';
import adminInferenceGatewayStats from './admin/inference-gateway-stats';
// owner-presence-human-turn-signal-2026-07-11 P-002 — human-turn presence signal (all backends).
import adminOwnerPresenceTouch from './admin/owner-presence-touch';
import adminDeployAccountsRemove from './admin/deploy-accounts-remove';
import adminDeployAccountsReset from './admin/deploy-accounts-reset';
// accounts-pool-tab-2026-06-15 P-002 — the experimental one-click OAuth account link.
import adminDeployAccountsLinkStart from './admin/deploy-accounts-link-start';
import adminDeployAccountsLinkComplete from './admin/deploy-accounts-link-complete';
import adminDeployAccountsLinkStatus from './admin/deploy-accounts-link-status';
// accounts-pool-tab-2026-06-15 P-004 — the owner's session-now account override (GET+POST).
import adminDeployAccountsSessionOverride from './admin/deploy-accounts-session-override';
import adminEmbedBackfill from './admin/embed-backfill';
import adminExecuteAction from './admin/execute-action';
import adminLlmTestsFindings from './admin/llm-tests-findings';
import adminLlmTestsFindingById from './admin/llm-tests-finding-by-id';
import adminLlmTestsRuns from './admin/llm-tests-runs';
import adminLlmTestsRunById from './admin/llm-tests-run-by-id';
import adminLlmTestsScenarios from './admin/llm-tests-scenarios';
import adminPlans from './admin/plans';
import adminCoord from './admin/coord';
import adminMode from './admin/mode';
import adminAccountsPin from './admin/accounts-pin';
import adminConfig from './admin/config';
import adminCoordInboxReply from './admin/coord-inbox-reply';
import adminAttentionBulkResolve from './admin/attention-bulk-resolve';
import adminPlanCleanup from './admin/plan-cleanup';
import adminCoordination from './admin/coordination';
import adminComms from './admin/comms';
import adminInbox from './admin/inbox';
import adminLocksQueue from './admin/locks-queue';
import adminDogfoodSubstrateStatus from './admin/dogfood-substrate-status';
import adminDogfoodSubstrateHealth from './admin/dogfood-substrate-health';
import adminDogfoodSubstrateBootHistory from './admin/dogfood-substrate-boot-history';
import adminSubstrateRevokeSelfDevice from './admin/substrate-revoke-self-device';
import adminSubstrateRevokeContributor from './admin/substrate-revoke-contributor';
import advSessions from './adv/sessions';
import fleetAgentPrompt from './fleet/agent-prompt';
import advLaunchSu from './adv/launch-su';
import advLaunchPui from './adv/launch-pui';
import adminPruneExecutedActions from './admin/prune-executed-actions';
import adminRotateToken from './admin/rotate-token';
import adminRun from './admin/run';
import adminSpawnSigningFailures from './admin/spawn-signing-failures';
import adminSpawnSigningRotate from './admin/spawn-signing-rotate';
import adminTables from './admin/tables';
import adminTablesByName from './admin/tables-by-name';
import adminTestingAiExplore from './admin/testing-ai-explore';
import adminTestingChaosWeb from './admin/testing-chaos-web';
import adminTestingTestRuns from './admin/testing-test-runs';
import adminTestingTestRunsById from './admin/testing-test-runs-by-id';
import adminTestingTestRunsCancel from './admin/testing-test-runs-cancel';
import adminTestingDesktopPerfTrend from './admin/testing-desktop-perf-trend';
import adminTestingDesktopPerfIngest from './admin/testing-desktop-perf-ingest';
import adminTestingMemoryHealth from './admin/testing-memory-health';
import adminTestingMemoryPreflight from './admin/testing-memory-preflight';
import adminTestingMemoryChecks from './admin/testing-memory-checks';
import adminTestingMemoryProbe from './admin/testing-memory-probe';
import adminTestingDomains from './admin/testing-domains';
import adminTestingDomainDetail from './admin/testing-domain-detail';
import adminTestingFileStatus from './admin/testing-file-status';
import adminTestingRun from './admin/testing-run';
import adminTestingRunById from './admin/testing-run-by-id';
import adminTestingFileHistory from './admin/testing-file-history';
import adminTestingHealthStrip from './admin/testing-health-strip';
import adminDbosStatus from './admin/dbos-status';
import adminSchedulesInventory from './admin/schedules-inventory';
import adminExternalTriggers from './admin/external-triggers';
// task-manager-no-escape-2026-07-27 P-017: the read side of the Task Manager pane.
// Read-only by construction — the kill/freeze/limit verbs are MCP tools behind
// processes:kill / processes:control, never a dashboard fetch.
import adminTaskManager from './admin/task-manager';
// goals-tab-improvement-2026-08-09 P-016: the desktop-callable goal WRITE, proxying the
// real `goals:update` tool so the status fan-out (placement gate / re-open) is never
// re-implemented behind a second write path.
import adminGoals from './admin/goals';
import adminDbosPipelineStart from './admin/dbos-pipeline-start';
import workspaces from './workspaces/index';
import workspaceById from './workspaces/by-id';
import workspaceSwitch from './workspaces/switch';
import workspaceHostAudit from './workspace-hosts/audit';
import workspaceHostAwsSetupTemplate from './workspace-hosts/aws-setup-template';
import workspaceHostAction from './workspace-hosts/action';
import workspaceHostAgentCredentials from './workspace-hosts/agent-credentials';
import workspaceHostCanary from './workspace-hosts/canary';
import workspaceHostConnection from './workspace-hosts/connection';
import workspaceHostByocClientKey from './workspace-hosts/byoc-client-key';
import workspaceHostCredentialLifecycle from './workspace-hosts/credential-lifecycle';
import workspaceHostInitialize from './workspace-hosts/initialize';
import workspaceHostDesktopPack from './workspace-hosts/desktop-pack';
import workspaceHostSoak from './workspace-hosts/soak';
import workspaceHostProvision from './workspace-hosts/provision';
import userActionsBySlug from './user-actions/by-slug';
import userActionsLog from './user-actions/log';
import elevenlabsWebhook from './elevenlabs/webhook';
import elevenlabsPostCall from './elevenlabs/post-call';
import miscScratch from './misc/scratch';
import deviceQrSvg from './device/qr-svg';
import devicePair from './device/pair';
import connectedApps from './connected-apps';
import connectedAppsOAuth from './connected-apps/oauth';
import ownTunnel from './own-tunnel';
import portalRelay from './portal-relay';
import webhookIngress from './webhooks';
import remoteAccess from './remote-access';
import deviceVoice from './device/voice';
import deviceOperator from './device/operator';
import deviceHarnesses from './device/harnesses';
import deviceSync from './device/sync';
import devicePush from './device/push';
import deviceOperatorConverse from './device/operator-converse';
import deviceVoiceTurn from './device/voice-turn';
import devicePlans from './device/plans';
import deviceAttention from './device/attention';
import deviceMonitoring from './device/monitoring';
import coordRoutes from './coord/index';
import tuiRoutes from './tui/index';
import activityRoutes from './activity/index';
import authorityRoutes from './authority/index';
import suLocksHookHealth from './su-locks/hook-health';
import suLocksForeignGuard from './su-locks/foreign-guard';
import operatorNotesRoutes from './operator-notes/index';
import oracleRoutes from './oracle/index';
import dockLayoutsRoutes from './dock-layouts/index';
import themesRoutes from './themes/index';
import crossHarnessRoutes from './cross-harness/index';
import projectsRoutes from './projects/index';
import ptyRoutes from './pty/index';
import agentChatsRoutes from './agent-chats/index';
import designFeatures from './design/features';
import designRegressions from './design/regressions';
import designRegressionFile from './design/regression-file';
import designSketches from './design/sketches';
import userPreferences from './user/preferences';
import userSearch from './user/search';
import notesRoutes from './notes/notes';
import userMemory from './user/memory';
import userMemoryFeedback from './user/memory-feedback';
import userMemoryReembed from './user/memory-reembed';
import userKnowledgePackSettings from './user/knowledge-pack-settings';
import userJevSettings from './user/jev-settings';
import userEmbedDevice from './user/embed-device';
import userMemoryRelinkEntities from './user/memory-relink-entities';
import userMemoryAudit from './user/memory-audit';
import userPersonalVault from './user/personal-vault';
import devSql from './dev/sql';
import devProcessesKill from './dev/processes-kill';
import devTables from './dev/tables';
import devTableSchema from './dev/table-schema';
import devTableRows from './dev/table-rows';
import devDrizzleStudio from './dev/drizzle-studio';
import desktopGitPipeline from './desktop/git-pipeline';
import desktopGitRemoteMain from './desktop/git-remote-main';
import desktopGitPotGreenCmd from './desktop/git-pot-green-cmd';
import desktopGitHiveMode from './desktop/git-hive-mode';
// dogfood-silent-canonical-hive-join P-013/P-014 — the cross-platform env switcher's
// operator-discovery feed (server-side reachability of the dev/prod/staging/local +
// release envs).
import desktopDevOperators from './desktop/dev-operators';
// Legacy /templates routes + the dead :3057 marketplace install/slug/uninstall
// are RETIRED (revive-cupboard-distribution D-004). Only catalog (bundled) +
// spawnable survive — ungated internal scaffold-support endpoints, no :3057.
import marketplaceCatalog from './marketplace/catalog';
import marketplaceSpawnable from './marketplace/spawnable';
import gymControl from './gym/control';
import externalBenchPreserved from './external-bench/preserved';
import externalBenchLaunch from './external-bench/launch';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

function flatten(entry: AnyRoute | AnyRoute[]): AnyRoute[] {
  return Array.isArray(entry) ? entry : [entry];
}

/** Every registered route, flattened. The order here is the mount order. */
export const ALL_ROUTES: ReadonlyArray<AnyRoute> = [
  ...flatten(desktopVersion as AnyRoute | AnyRoute[]),
  ...flatten(deployFrameView as AnyRoute),
  ...flatten(deployFrames as AnyRoute),
  ...flatten(deployLocalDesktops as AnyRoute),
  ...flatten(deployLocalDesktopThumbnail as AnyRoute),
  ...flatten(discoveryPots as AnyRoute),
  ...flatten(discoveryFederationStatus as AnyRoute),
  ...flatten(discoveryPotMeta as AnyRoute),
  ...flatten(discoverySetPot as AnyRoute),
  ...flatten(discoveryBeaconConsent as AnyRoute[]),
  ...flatten(discoveryJoinInvite as AnyRoute),
  ...flatten(discoveryJoinPot as AnyRoute),
  ...flatten(githubSearchRepos as AnyRoute),
  ...flatten(deployVncSession as AnyRoute),
  ...flatten(agentMcp_agents as AnyRoute),
  ...flatten(agentMcp_consoleLaunch as AnyRoute[]),
  ...flatten(agentMcp_consoleLaunchBridge as AnyRoute[]),
  ...flatten(agentMcp_consoleResolve as AnyRoute),
  ...flatten(agentMcp_consoleRecord as AnyRoute),
  ...flatten(agentMcp_bootstrapSu as AnyRoute[]),
  ...flatten(agentMcp_bootstrapSuPersonaRefresh as AnyRoute[]),
  ...flatten(agentMcp_recoveryAuditReconcile as AnyRoute),
  ...flatten(agentMcp_bootstrapRole as AnyRoute[]),
  ...flatten(agentMcp_sessionRecoveryBrief as AnyRoute[]),
  ...flatten(agentMcp_contextEpochBump as AnyRoute[]),
  ...flatten(agentMcp_turnEndDirectiveCheck as AnyRoute[]),
  ...flatten(agentMcp_restrictedEgressCheck as AnyRoute[]),
  ...flatten(agentMcp_turnStartMemory as AnyRoute[]),
  ...flatten(agentMcp_midTurnContext as AnyRoute[]),
  ...flatten(agentMcp_identityHookSinks as AnyRoute[]),
  ...flatten(agentMcp_rebindIdentity as AnyRoute[]),
  ...flatten(agentMcp_decisions as AnyRoute),
  ...flatten(agentMcp_delegateChat as AnyRoute),
  ...flatten(agentMcp_operatorHindsight as AnyRoute[]),
  ...flatten(agentMcp_delegates as AnyRoute[]),
  ...flatten(agentMcp_elAdminCreds as AnyRoute),
  ...flatten(agentMcp_endPi as AnyRoute),
  ...flatten(agentMcp_events as AnyRoute),
  ...flatten(agentMcp_ompConfig as AnyRoute[]),
  ...flatten(agentMcp_operatorAudit as AnyRoute),
  ...flatten(agentMcp_operatorBudget as AnyRoute[]),
  ...flatten(agentMcp_operatorCartesiaTest as AnyRoute),
  ...flatten(agentMcp_operatorConfig as AnyRoute[]),
  ...flatten(agentMcp_savedPrompts as AnyRoute[]),
  ...flatten(agentMcp_operatorConverse as AnyRoute),
  ...flatten(agentMcp_operatorConvVoice as AnyRoute[]),
  ...flatten(agentMcp_operatorCredentials as AnyRoute[]),
  ...flatten(agentMcp_operatorDispatch as AnyRoute),
  ...flatten(agentMcp_operatorElevenlabsBootstrap as AnyRoute),
  ...flatten(agentMcp_operatorElevenlabsWsInit as AnyRoute[]),
  ...flatten(agentMcp_operatorElevenlabsTest as AnyRoute),
  ...flatten(agentMcp_operatorElevenlabsVoices as AnyRoute),
  ...flatten(agentMcp_operatorVoiceEngineHealth as AnyRoute),
  ...flatten(agentMcp_operatorVoiceProvision as AnyRoute),
  ...flatten(agentMcp_operatorElSpend as AnyRoute),
  ...flatten(agentMcp_operatorElSubscription as AnyRoute),
  ...flatten(agentMcp_operatorMessageStatus as AnyRoute),
  ...flatten(agentMcp_operatorMultiWorkspace as AnyRoute),
  ...flatten(agentMcp_operatorNudge as AnyRoute),
  ...flatten(agentMcp_operatorOpenaiTest as AnyRoute),
  ...flatten(agentMcp_operatorPauseFlag as AnyRoute[]),
  ...flatten(agentMcp_operatorPicovoiceBootstrap as AnyRoute),
  ...flatten(agentMcp_operatorPreferences as AnyRoute[]),
  ...flatten(agentMcp_operatorRealtimeBootstrap as AnyRoute),
  ...flatten(agentMcp_operatorStandingApprovals as AnyRoute[]),
  ...flatten(agentMcp_operatorStats as AnyRoute),
  ...flatten(agentMcp_operatorStt as AnyRoute),
  ...flatten(agentMcp_operatorSttBootstrap as AnyRoute),
  ...flatten(agentMcp_operatorSttSpend as AnyRoute[]),
  ...flatten(agentMcp_operatorTriggerState as AnyRoute),
  ...flatten(agentMcp_operatorTts as AnyRoute),
  ...flatten(agentMcp_operatorTtsPreview as AnyRoute),
  ...flatten(agentMcp_operatorTtsSpend as AnyRoute[]),
  ...flatten(agentMcp_operatorVoicePrefs as AnyRoute[]),
  ...flatten(agentMcp_provision as AnyRoute),
  ...flatten(agentMcp_runCommandResult as AnyRoute),
  ...flatten(agentMcp_runCommandSse as AnyRoute),
  ...flatten(agentMcp_runCommand as AnyRoute),
  ...flatten(agentMcp_capabilities as AnyRoute),
  ...flatten(agentMcp_runTool as AnyRoute),
  ...flatten(agentMcp_autonomyPolicySet as AnyRoute),
  ...flatten(agentMcp_storagePrune as AnyRoute),
  ...flatten(agentMcp_autonomyTripwireRevert as AnyRoute),
  ...flatten(agentMcp_trustSet as AnyRoute),
  ...flatten(agentMcp_p2pSettingsSet as AnyRoute),
  ...flatten(agentMcp_consultExpertRoutingSet as AnyRoute),
  ...flatten(agentMcp_p2pGrantSet as AnyRoute),
  ...flatten(agentMcp_p2pAllotmentSet as AnyRoute),
  ...flatten(agentMcp_potOverrideSet as AnyRoute),
  ...flatten(agentMcp_identityManagement as AnyRoute),
  ...flatten(agentMcp_spawnPi as AnyRoute),
  ...flatten(agentMcp_voiceDebug as AnyRoute[]),
  ...flatten(agentMcp_voiceUtteranceLog as AnyRoute),
  ...flatten(agentMcp_workspaceCompanyId as AnyRoute[]),
  ...flatten(openapiJson as AnyRoute),
  ...flatten(flagsWebhook as AnyRoute),
  ...flatten(flagsBootstrap as AnyRoute),
  ...flatten(flagsStream as AnyRoute),
  ...flatten(flagsSet as AnyRoute),
  ...flatten(workScopeRoutes as AnyRoute[]),
  ...flatten(flagsTestingFeatures as AnyRoute[]),
  ...flatten(flagsPreset as AnyRoute),
  ...flatten(flagsDashboardUrl as AnyRoute),
  ...flatten(operatorStateSnapshot as AnyRoute),
  ...flatten(operatorSettingsByKey as AnyRoute),
  ...flatten(operatorRateLimitConfig as AnyRoute[]),
  ...flatten(operatorConversations as AnyRoute[]),
  ...flatten(operatorConversationTurns as AnyRoute[]),
  ...flatten(operatorCardResponse as AnyRoute),
  ...flatten(operatorSilenceNudge as AnyRoute),
  ...flatten(operatorRunCancel as AnyRoute),
  ...flatten(operatorPapercupInput as AnyRoute),
  ...flatten(operatorPapercupOutput as AnyRoute[]),
  ...flatten(operatorTurnAnswer as AnyRoute),
  // oddsmith P-020 engine↔operator bridge (additive + inert until armed).
  ...flatten(operatorEventsEmit as AnyRoute),
  ...flatten(operatorHiveSteering as AnyRoute),
  ...flatten(backupsIndex as AnyRoute[]),
  ...flatten(backupsBrokenList as AnyRoute),
  ...flatten(backupsFailures as AnyRoute),
  ...flatten(backupsMaintenance as AnyRoute),
  ...flatten(backupsRollback as AnyRoute),
  ...flatten(backupsServer as AnyRoute[]),
  ...flatten(backupsVerify as AnyRoute),
  ...flatten(backupsDestination as AnyRoute[]),
  ...flatten(backupsEvents as AnyRoute),
  ...flatten(backupsHealthcheck as AnyRoute),
  ...flatten(backupsPromote as AnyRoute),
  ...flatten(backupsRestore as AnyRoute),
  ...flatten(backupsSnapshots as AnyRoute[]),
  ...flatten(harnessProjects as AnyRoute[]),
  ...flatten(knowledgePacksRoutes as AnyRoute[]),
  ...flatten(harnessMembership as AnyRoute[]),
  ...flatten(harnessJoinLink as AnyRoute),
  ...flatten(harnessBindingClaim as AnyRoute[]),
  ...flatten(harnessClaimStatus as AnyRoute[]),
  ...flatten(potPolicy as AnyRoute[]),
  ...flatten(potRateState as AnyRoute[]),
  ...flatten(harnessContributors as AnyRoute[]),
  ...flatten(harnessContributorUsage as AnyRoute[]),
  ...flatten(harnessActivity as AnyRoute[]),
  ...flatten(harnessInsights as AnyRoute[]),
  ...flatten(harnessInsightsFirstVisit as AnyRoute[]),
  ...flatten(harnessClaimAttempts as AnyRoute[]),
  ...flatten(harnessBootstrapProgress as AnyRoute[]),
  ...flatten(harnessFeatureQueue as AnyRoute[]),
  ...flatten(harnessClaimFeature as AnyRoute[]),
  ...flatten(harnessClobberStream as AnyRoute),
  ...flatten(harnessWorkingSet as AnyRoute[]),
  ...flatten(usersByGithubId as AnyRoute[]),
  ...flatten(usersByLogin as AnyRoute[]),
  ...flatten(usersViewer as AnyRoute[]),
  ...flatten(harnessPrs as AnyRoute[]),
  ...flatten(harnessPrReviewerSettings as AnyRoute[]),
  ...flatten(harnessProjectDocs as AnyRoute[]),
  ...flatten(harnessDocs as AnyRoute[]),
  ...flatten(harnessSync as AnyRoute[]),
  ...flatten(cupboard as AnyRoute[]),
  ...flatten(cupboardInstallPlugin as AnyRoute),
  ...flatten(cupboardInstallDeps as AnyRoute),
  ...flatten(cupboardPublishPlugin as AnyRoute),
  ...flatten(cupboardInstallBlueprint as AnyRoute),
  ...flatten(cupboardPublishBlueprint as AnyRoute),
  ...flatten(cupboardInstallTemplate as AnyRoute),
  ...flatten(cupboardInstallTheme as AnyRoute),
  ...flatten(cupboardPublishTemplate as AnyRoute),
  ...flatten(cupboardInstallApp as AnyRoute),
  ...flatten(harnessSpec as AnyRoute[]),
  ...flatten(harnessBlueprintParams as AnyRoute[]),
  ...flatten(harnessWorkItems as AnyRoute[]),
  ...flatten(promptStudio as AnyRoute[]),
  ...flatten(harnessDiscord as AnyRoute[]),
  ...flatten(harnessIntegrationMode as AnyRoute[]),
  harnessAssertion as AnyRoute,
  ...flatten(harnessTextViews as AnyRoute[]),
  ...flatten(harnessRuns as AnyRoute[]),
  ...flatten(harnessStandaloneViews as AnyRoute[]),
  ...flatten(harnessProjectStats as AnyRoute[]),
  ...flatten(harnessStateViews as AnyRoute[]),
  ...flatten(harnessNotesDiff as AnyRoute[]),
  ...flatten(harnessFeatureViews as AnyRoute[]),
  ...flatten(harnessFeatures as AnyRoute[]),
  ...flatten(harnessEndpoint as AnyRoute[]),
  ...flatten(harnessAdaptiveTelemetry as AnyRoute[]),
  ...flatten(harnessProposalsViews as AnyRoute[]),
  ...flatten(harnessProposals as AnyRoute[]),
  ...flatten(harnessScoperActions as AnyRoute[]),
  ...flatten(harnessArchives as AnyRoute[]),
  ...flatten(harnessSupervisorActions as AnyRoute[]),
  ...flatten(harnessOrchestrationActions as AnyRoute[]),
  ...flatten(harnessTests as AnyRoute[]),
  ...flatten(harnessTesting as AnyRoute[]),
  ...flatten(harnessUsage as AnyRoute[]),
  ...flatten(harnessAgents as AnyRoute[]),
  ...flatten(harnessScreenshots as AnyRoute[]),
  ...flatten(harnessSnapshots as AnyRoute[]),
  ...flatten(harnessHooks as AnyRoute[]),
  ...flatten(harnessConfigFiles as AnyRoute[]),
  ...flatten(harnessSkillsNotes as AnyRoute[]),
  ...flatten(harnessPrompts as AnyRoute[]),
  ...flatten(harnessBrainstorm as AnyRoute[]),
  ...flatten(harnessCompletionRefRecheck as AnyRoute[]),
  ...flatten(harnessGit as AnyRoute[]),
  ...flatten(harnessProcessControl as AnyRoute[]),
  ...flatten(harnessReviews as AnyRoute[]),
  ...flatten(harnessMemory as AnyRoute[]),
  ...flatten(harnessPhases as AnyRoute[]),
  ...flatten(harnessIssues as AnyRoute[]),
  ...flatten(harnessStreams as AnyRoute[]),
  ...flatten([harnessStatus] as AnyRoute[]),
  ...flatten([harnessProjectHistory] as AnyRoute[]),
  ...flatten([harnessLogHistory] as AnyRoute[]),
  ...flatten(harnessSpawn as AnyRoute[]),
  ...flatten([harnessBootstrapFromTemplate] as AnyRoute[]),
  ...flatten(harnessPromote as AnyRoute[]),
  ...flatten(harnessAllKpis as AnyRoute),
  ...flatten(harnessFile as AnyRoute[]),
  ...flatten(harnessManifest as AnyRoute),
  ...flatten(harnessIntelArtifacts as AnyRoute),
  ...flatten(harnessIntelSpawnTree as AnyRoute),
  ...flatten(harnessBranchActions as AnyRoute),
  ...flatten(harnessBranchActionRun as AnyRoute),
  ...flatten(harnessBranchActionStream as AnyRoute),
  ...flatten(harnessBranchActionByNameRun as AnyRoute),
  ...flatten(uiPresence as AnyRoute),
  ...flatten(uiIntentsStream as AnyRoute),
  ...flatten(uiIntentResult as AnyRoute),
  ...flatten(zeroHarnessSse as AnyRoute),
  ...flatten(zeroHarnessRestQuery as AnyRoute),
  ...flatten(agentToolsCatchall as AnyRoute[]),
  ...flatten(pluginRuntimeCatchall as AnyRoute),
  ...flatten(internalLogEvent as AnyRoute),
  ...flatten(internalRunChunk as AnyRoute),
  ...flatten(internalDecisionEvent as AnyRoute),
  ...flatten(internalEscalationEvent as AnyRoute),
  ...flatten(internalArchiveEvent as AnyRoute),
  ...flatten(internalCheckpointEvent as AnyRoute),
  ...flatten(internalFeatureDebugNoteEvent as AnyRoute),
  ...flatten(internalHookLogEvent as AnyRoute),
  ...flatten(internalIdentitySnapshot as AnyRoute),
  ...flatten(internalPrEvent as AnyRoute),
  ...flatten(internalSkillSnapshot as AnyRoute),
  ...flatten(internalSmokeTestEvent as AnyRoute),
  ...flatten(internalTestSnapshot as AnyRoute),
  // Literal plugins routes before the catch-all.
  ...flatten(pluginsEnabled as AnyRoute),
  ...flatten(pluginsManifest as AnyRoute),
  ...flatten(pluginsGlobal as AnyRoute),
  ...flatten(pluginsGrants as AnyRoute[]),
  ...flatten(pluginsInvoke as AnyRoute),
  ...flatten(pluginsTools as AnyRoute),
  ...flatten(pluginsUninstall as AnyRoute),
  ...flatten(pluginsEnable as AnyRoute),
  ...flatten(pluginsConfig as AnyRoute[]),
  ...flatten(pluginsConfigs as AnyRoute),
  ...flatten(pluginsHostRuntimeStatus as AnyRoute),
  ...flatten(pluginsHostEvents as AnyRoute),
  ...flatten(pluginsHostQuery as AnyRoute),
  ...flatten(pluginsHostInvoke as AnyRoute),
  ...flatten(pluginsHostRefresh as AnyRoute[]),
  ...flatten(pluginsContributions as AnyRoute),
  ...flatten(pluginsIframeEntry as AnyRoute),
  ...flatten(pluginsUpdates as AnyRoute),
  // Relocated from _hono/plugins.ts (A3, 2026-05-21).
  ...flatten(pluginsList as AnyRoute),
  ...flatten(pluginsInstalled as AnyRoute),
  ...flatten(pluginsRuntimeStatus as AnyRoute),
  ...flatten(pluginsRuntimeInvokeAction as AnyRoute),
  ...flatten(pluginsRuntimeFireEvent as AnyRoute),
  // Plugins catch-all after literals — plugin-apiRoutes registry, then projected-tool dispatch.
  ...flatten(pluginsCatchall as AnyRoute[]),
  // Transport last — single-segment :transport must not shadow literal paths.
  ...flatten(transport as AnyRoute[]),
  ...flatten(devRouteInvocations as AnyRoute),
  ...flatten(agentConfig as AnyRoute[]),
  ...flatten(agentConfigTest as AnyRoute),
  ...flatten(credentials as AnyRoute[]),
  ...flatten(credentialsSearchProviders as AnyRoute[]),
  ...flatten(agentTokensPowerUser as AnyRoute),
  ...flatten(agentTokensPowerUserRefresh as AnyRoute),
  ...flatten(installed as AnyRoute),
  ...flatten(installedPrune as AnyRoute),
  ...flatten(oauthStart as AnyRoute),
  ...flatten(oauthCallback as AnyRoute),
  ...flatten(oauthVerifyPaste as AnyRoute),
  ...flatten(publishCredentials as AnyRoute[]),
  ...flatten(publishCredentialsRotate as AnyRoute),
  ...flatten(miscRuntimeVintageReport as AnyRoute),
  ...flatten(miscMemoryCanaryProbe as AnyRoute),
  ...flatten(miscDomainReadCanary as AnyRoute),
  ...flatten(miscManagedTimers as AnyRoute),
  ...flatten(miscFlagAttest as AnyRoute),
  ...flatten(miscSubstrateHeadSnapshot as AnyRoute),
  ...flatten(miscSubstrateOwnCompaction as AnyRoute),
  ...flatten(miscHealth as AnyRoute),
  ...flatten(miscHealthReady as AnyRoute),
  ...flatten(miscHealthDeep as AnyRoute),
  ...flatten(miscToastLog as AnyRoute[]),
  ...flatten(miscWikiBacklinks as AnyRoute),
  ...flatten(miscProfile as AnyRoute[]),
  ...flatten(miscSecurityAdvisoriesCheck as AnyRoute),
  ...flatten(miscAgentBundle as AnyRoute),
  ...flatten(miscTestButtonsEcho as AnyRoute),
  ...flatten(miscUpdatesManifest as AnyRoute),
  ...flatten(miscUpdatesHistory as AnyRoute),
  ...flatten(miscUpdatesRollback as AnyRoute),
  ...flatten(miscUpdatesDownload as AnyRoute),
  ...flatten(authLogin as AnyRoute),
  ...flatten(authLogout as AnyRoute),
  ...flatten(authSignup as AnyRoute),
  ...flatten(authChangePassword as AnyRoute),
  ...flatten(authMe as AnyRoute[]),
  ...flatten(provisionConsent as AnyRoute[]),
  ...flatten(provisionHostCheck as AnyRoute[]),
  ...flatten(provisionState as AnyRoute),
  ...flatten(provisionRun as AnyRoute),
  ...flatten(provisionStream as AnyRoute),
  ...flatten(desktopAgentAuthStatus as AnyRoute),
  ...flatten(desktopAgentLoginEnvelope as AnyRoute),
  ...flatten(desktopGitIdentity as AnyRoute[]),
  ...flatten(desktopLocalModelStatus as AnyRoute),
  ...flatten(desktopLocalModelInstall as AnyRoute),
  ...flatten(desktopPreflight as AnyRoute[]),
  ...flatten(desktopOnboardingLaunchContext as AnyRoute),
  ...flatten(desktopOnboardingStatus as AnyRoute),
  ...flatten(desktopTutorialScript as AnyRoute),
  ...flatten(desktopDocsQa as AnyRoute),
  ...flatten(desktopDocsAgentAsk as AnyRoute),
  ...flatten(desktopSetupPtyCommands as AnyRoute),
  ...flatten(desktopSetupStatus as AnyRoute),
  ...flatten(desktopSetupWizardState as AnyRoute[]),
  ...flatten(desktopTelemetryConfig as AnyRoute),
  ...flatten(desktopTelemetryFlush as AnyRoute),
  ...flatten(desktopTelemetryReport as AnyRoute[]),
  ...flatten(desktopVoiceConfig as AnyRoute[]),
  ...flatten(desktopWorkspaceValidate as AnyRoute),
  ...flatten(desktopInstallPapercuspFiles as AnyRoute[]),
  ...flatten(desktopInstallOmpIntegration as AnyRoute[]),
  ...flatten(desktopBootstrapPotStart as AnyRoute[]),
  desktopGithubUser as AnyRoute,
  ...flatten(adminBackupOrphanCleanup as AnyRoute),
  ...flatten(adminCommands as AnyRoute),
  ...flatten(adminDeployAccountsList as AnyRoute),
  ...flatten(adminDeployAccountsRegister as AnyRoute),
  ...flatten(adminInferenceGatewayStats as AnyRoute),
  ...flatten(adminOwnerPresenceTouch as AnyRoute),
  ...flatten(adminDeployAccountsRemove as AnyRoute),
  ...flatten(adminDeployAccountsReset as AnyRoute),
  ...flatten(adminDeployAccountsLinkStart as AnyRoute),
  ...flatten(adminDeployAccountsLinkComplete as AnyRoute),
  ...flatten(adminDeployAccountsLinkStatus as AnyRoute),
  ...flatten(adminDeployAccountsSessionOverride as AnyRoute[]),
  ...flatten(adminEmbedBackfill as AnyRoute),
  ...flatten(adminExecuteAction as AnyRoute),
  ...flatten(adminLlmTestsFindings as AnyRoute),
  ...flatten(adminLlmTestsFindingById as AnyRoute),
  ...flatten(adminLlmTestsRuns as AnyRoute),
  ...flatten(adminLlmTestsRunById as AnyRoute),
  ...flatten(adminLlmTestsScenarios as AnyRoute),
  ...flatten(adminPlans as AnyRoute[]),
  ...flatten(adminCoord as AnyRoute[]),
  ...flatten(adminMode as AnyRoute[]),
  ...flatten(adminAccountsPin as AnyRoute[]),
  ...flatten(adminConfig as AnyRoute[]),
  ...flatten(adminCoordInboxReply as AnyRoute[]),
  ...flatten(adminAttentionBulkResolve as AnyRoute[]),
  ...flatten(adminPlanCleanup as AnyRoute[]),
  ...flatten(adminCoordination as AnyRoute[]),
  ...flatten(adminComms as AnyRoute[]),
  ...flatten(adminInbox as AnyRoute[]),
  ...flatten(adminLocksQueue as AnyRoute),
  ...flatten(adminDogfoodSubstrateStatus as AnyRoute[]),
  ...flatten(adminDogfoodSubstrateHealth as AnyRoute[]),
  ...flatten(adminDogfoodSubstrateBootHistory as AnyRoute[]),
  ...flatten(adminSubstrateRevokeSelfDevice as AnyRoute[]),
  ...flatten(adminSubstrateRevokeContributor as AnyRoute[]),
  ...flatten(advSessions as unknown as AnyRoute[]),
  ...flatten(fleetAgentPrompt as unknown as AnyRoute[]),
  ...flatten(advLaunchSu as unknown as AnyRoute[]),
  ...flatten(advLaunchPui as unknown as AnyRoute[]),
  ...flatten(adminPruneExecutedActions as AnyRoute),
  ...flatten(adminRotateToken as AnyRoute),
  ...flatten(adminRun as AnyRoute),
  ...flatten(adminSpawnSigningFailures as AnyRoute),
  ...flatten(adminSpawnSigningRotate as AnyRoute),
  ...flatten(adminTables as AnyRoute),
  ...flatten(adminTablesByName as AnyRoute[]),
  ...flatten(adminTestingAiExplore as AnyRoute),
  ...flatten(adminTestingChaosWeb as AnyRoute),
  ...flatten(adminTestingTestRuns as AnyRoute),
  ...flatten(adminTestingTestRunsById as AnyRoute),
  ...flatten(adminTestingTestRunsCancel as AnyRoute),
  ...flatten(adminTestingDesktopPerfTrend as AnyRoute),
  ...flatten(adminTestingDesktopPerfIngest as AnyRoute),
  ...flatten(adminTestingMemoryHealth as AnyRoute),
  ...flatten(adminTestingMemoryPreflight as AnyRoute),
  ...flatten(adminTestingMemoryChecks as AnyRoute),
  ...flatten(adminTestingMemoryProbe as AnyRoute),
  ...flatten(adminTestingDomains as AnyRoute),
  ...flatten(adminTestingDomainDetail as AnyRoute),
  ...flatten(adminDbosStatus as AnyRoute),
  ...flatten(adminSchedulesInventory as AnyRoute),
  ...flatten(adminExternalTriggers as AnyRoute[]),
  ...flatten(adminTaskManager as unknown as AnyRoute[]),
  ...flatten(adminGoals as unknown as AnyRoute[]),
  ...flatten(adminDbosPipelineStart as AnyRoute),
  ...flatten(adminTestingFileStatus as AnyRoute),
  ...flatten(adminTestingRun as AnyRoute),
  ...flatten(adminTestingRunById as AnyRoute[]),
  ...flatten(adminTestingFileHistory as AnyRoute),
  ...flatten(adminTestingHealthStrip as AnyRoute),
  ...flatten(workspaces as AnyRoute[]),
  ...flatten(workspaceById as AnyRoute[]),
  ...flatten(workspaceSwitch as AnyRoute),
  ...flatten(workspaceHostAudit as AnyRoute),
  ...flatten(workspaceHostAwsSetupTemplate as AnyRoute),
  ...flatten(workspaceHostAction as AnyRoute),
  ...flatten(workspaceHostAgentCredentials as AnyRoute),
  ...flatten(workspaceHostCanary as AnyRoute),
  ...flatten(workspaceHostConnection as AnyRoute),
  ...flatten(workspaceHostByocClientKey as AnyRoute[]),
  ...flatten(workspaceHostCredentialLifecycle as AnyRoute),
  ...flatten(workspaceHostInitialize as AnyRoute),
  ...flatten(workspaceHostDesktopPack as AnyRoute),
  ...flatten(workspaceHostSoak as AnyRoute[]),
  ...flatten(workspaceHostProvision as AnyRoute),
  ...flatten(userActionsBySlug as AnyRoute),
  ...flatten(userActionsLog as AnyRoute),
  ...flatten(elevenlabsWebhook as AnyRoute),
  ...flatten(elevenlabsPostCall as AnyRoute),
  ...flatten(miscScratch as AnyRoute),
  ...flatten(deviceQrSvg as AnyRoute),
  ...flatten(devicePair as AnyRoute[]),
  ...flatten(connectedApps as AnyRoute[]),
  ...flatten(connectedAppsOAuth as AnyRoute[]),
  ...flatten(ownTunnel as AnyRoute[]),
  ...flatten(portalRelay as AnyRoute[]),
  ...flatten(webhookIngress as AnyRoute[]),
  ...flatten(remoteAccess as AnyRoute[]),
  ...flatten(deviceVoice as AnyRoute[]),
  ...flatten(deviceOperator as AnyRoute[]),
  ...flatten(deviceHarnesses as AnyRoute[]),
  ...flatten(deviceSync as AnyRoute[]),
  ...flatten(devicePush as AnyRoute[]),
  ...flatten(deviceOperatorConverse as AnyRoute[]),
  ...flatten(deviceVoiceTurn as AnyRoute[]),
  ...flatten(devicePlans as AnyRoute[]),
  ...flatten(deviceAttention as AnyRoute[]),
  ...flatten(deviceMonitoring as AnyRoute[]),
  ...flatten(coordRoutes as AnyRoute[]),
  ...flatten(tuiRoutes as AnyRoute[]),
  ...flatten(activityRoutes as AnyRoute[]),
  ...flatten(authorityRoutes as AnyRoute[]),
  ...flatten(suLocksHookHealth as AnyRoute),
  ...flatten(suLocksForeignGuard as AnyRoute),
  ...flatten(operatorNotesRoutes as AnyRoute[]),
  ...flatten(oracleRoutes as AnyRoute[]),
  ...flatten(dockLayoutsRoutes as AnyRoute[]),
  ...flatten(themesRoutes as AnyRoute[]),
  ...flatten(crossHarnessRoutes as AnyRoute[]),
  ...flatten(projectsRoutes as AnyRoute[]),
  ...flatten(ptyRoutes as AnyRoute[]),
  ...flatten(agentChatsRoutes as AnyRoute[]),
  ...flatten(designFeatures as AnyRoute),
  ...flatten(designRegressions as AnyRoute),
  ...flatten(designRegressionFile as AnyRoute),
  ...flatten(designSketches as AnyRoute[]),
  ...flatten(userPreferences as AnyRoute[]),
  ...flatten(userSearch as AnyRoute),
  ...flatten(notesRoutes as AnyRoute[]),
  ...flatten(userMemory as AnyRoute[]),
  ...flatten(userMemoryFeedback as AnyRoute),
  ...flatten(userMemoryReembed as AnyRoute[]),
  ...flatten(userKnowledgePackSettings as AnyRoute[]),
  ...flatten(userJevSettings as AnyRoute[]),
  ...flatten(userEmbedDevice as AnyRoute[]),
  ...flatten(userMemoryRelinkEntities as AnyRoute),
  ...flatten(userMemoryAudit as AnyRoute),
  ...flatten(userPersonalVault as AnyRoute[]),
  ...flatten(devSql as AnyRoute),
  ...flatten(devProcessesKill as AnyRoute),
  ...flatten(devTables as AnyRoute),
  ...flatten(devTableSchema as AnyRoute),
  ...flatten(devTableRows as AnyRoute),
  ...flatten(devDrizzleStudio as AnyRoute[]),
  ...flatten(desktopGitPipeline as AnyRoute[]),
  ...flatten(desktopGitRemoteMain as AnyRoute[]),
  ...flatten(desktopGitPotGreenCmd as AnyRoute[]),
  ...flatten(desktopGitHiveMode as AnyRoute[]),
  ...flatten(desktopDevOperators as AnyRoute[]),
  ...flatten(marketplaceCatalog as AnyRoute),
  ...flatten(marketplaceSpawnable as AnyRoute),
  // Gym control-plane (gym-ui-handoff backend). /gym/harnesses (literal) precedes
  // /gym/:slug (param) within the array so it isn't shadowed.
  ...flatten(gymControl as unknown as AnyRoute[]),
  // Preserved external-bench runs (Evaluation "Preserved runs" surface). The
  // /external-bench/runs literal is sorted before /external-bench/runs/:id by
  // the registrar's bySpecificity ordering, so the list isn't shadowed.
  ...flatten(externalBenchPreserved as unknown as AnyRoute[]),
  ...flatten(externalBenchLaunch as unknown as AnyRoute[]),
];
