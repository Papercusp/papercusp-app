import { relations } from "drizzle-orm/relations";
import { backupSnapshotsInHarnessShared, backupEventsInHarnessShared, benchRunsInHarnessShared, benchRunEventsInHarnessShared, benchmarkRolloutInHarnessShared, benchmarkRunResultInHarnessShared, capabilityClassRegistryInHarnessShared, capabilityClassConformanceRunsInHarnessShared, connectedAppsInHarnessShared, connectedAppAccessTokensInHarnessShared, connectedAppOauthClientsInHarnessShared, connectedAppDeviceGrantsInHarnessShared, testingSurfacesInHarnessShared, coverageEvidenceInHarnessShared, testRunsInHarnessShared, coverageWaiversInHarnessShared, cupKeeperInstancesInHarnessShared, cupKeeperRunsInHarnessShared, eventAwaitNodesInHarnessShared, goalsInHarnessShared, goalPotsInHarnessShared, llmTestRunsInHarnessShared, llmTestFindingsInHarnessShared, llmTestFixturesInHarnessShared, memoryPrecisionBenchInHarnessShared, memoryPrecisionBenchAttemptsInHarnessShared, memoryRecallStatsInHarnessShared, memoryRecallQueryTextInHarnessShared, memoryCanonicalInHarnessShared, memoryVecGemmaInHarnessShared, memoryVecHarrierInHarnessShared, memoryVecLocalInHarnessShared, memoryVecOpenaiInHarnessShared, operatorConversationsInHarnessShared, operatorTurnsInHarnessShared, planRunsInHarnessShared, planRunTurnsInHarnessShared, potEvalInstancesInHarnessShared, potEvalRunsInHarnessShared, projectsInHarnessShared, projectSpecRevisionsInHarnessShared, routineGroupsInHarnessShared, routinesInHarnessShared, savedPromptsInHarnessShared, workItemSpecRevisionEdgesInHarnessShared, specEvidenceBindingsInHarnessShared, usersInHarnessShared, userSessionsInHarnessShared, messagesInPapercuspShared, messageCommentsInPapercuspShared, messageRecipientsInPapercuspShared, connectedAppClientAssertionsInHarnessShared, mobilePushTokensInHarnessShared, userPreferencesInHarnessShared, blueprintPackageResourcesInHarnessShared, blueprintPackageDependentsInHarnessShared, personalVaultSettingsInHarnessShared, memoryAnchorsInHarnessShared, appOwnerMappingsInHarnessShared, personalSyncStateInHarnessShared, sessionTasksInHarnessShared, sessionTaskWorkItemLinksInHarnessShared, personalIdentitiesInHarnessShared, reportLibraryInHarnessShared, reportLibraryChunksInHarnessShared, planSpecClauseRevisionsInHarnessShared, planSpecClausesInHarnessShared, harnessPlansInHarnessShared, workItemsInHarnessShared, personalIdentityAliasesInHarnessShared, workspaceHostsInHarnessShared, workspaceHostLogsInHarnessShared, workspaceHostOperationsInHarnessShared, personalGrantsInHarnessShared, personalVaultImportUploadsInHarnessShared, planDecisionsInHarnessShared, capabilityClassProviderBindingsInHarnessShared, potCapabilityClassBindingsInHarnessShared, sessionTurnsInHarnessShared, sessionTurnChunksInHarnessShared, workspaceHostEventsInHarnessShared, workspaceHostInitializationStepsInHarnessShared, planItemsInHarnessShared, triggerSourcesInHarnessShared, potEvalScoresInHarnessShared, datatypeRegistryInHarnessShared, triggerDeliveriesInHarnessShared, triggerBindingsInHarnessShared, triggerRunsInHarnessShared, benchRunTasksInHarnessShared, cupKeeperScoresInHarnessShared, workspaceHostResourcesInHarnessShared, customerWorkspacesInHarnessShared, workspaceGrantsInHarnessShared, triageSnapshotsInHarnessShared, triageLedgerInHarnessShared, personalDocumentsInHarnessShared, potsInHarnessShared, potMembersInHarnessShared, personalVaultImportJobsInHarnessShared, workspaceHostConnectionsInHarnessShared } from "./generated";

export const backupEventsInHarnessSharedRelations = relations(backupEventsInHarnessShared, ({one}) => ({
	backupSnapshotsInHarnessShared: one(backupSnapshotsInHarnessShared, {
		fields: [backupEventsInHarnessShared.snapshotId],
		references: [backupSnapshotsInHarnessShared.id]
	}),
}));

export const backupSnapshotsInHarnessSharedRelations = relations(backupSnapshotsInHarnessShared, ({many}) => ({
	backupEventsInHarnessShareds: many(backupEventsInHarnessShared),
}));

export const benchRunEventsInHarnessSharedRelations = relations(benchRunEventsInHarnessShared, ({one}) => ({
	benchRunsInHarnessShared: one(benchRunsInHarnessShared, {
		fields: [benchRunEventsInHarnessShared.runId],
		references: [benchRunsInHarnessShared.id]
	}),
}));

export const benchRunsInHarnessSharedRelations = relations(benchRunsInHarnessShared, ({many}) => ({
	benchRunEventsInHarnessShareds: many(benchRunEventsInHarnessShared),
	benchRunTasksInHarnessShareds: many(benchRunTasksInHarnessShared),
}));

export const benchmarkRunResultInHarnessSharedRelations = relations(benchmarkRunResultInHarnessShared, ({one}) => ({
	benchmarkRolloutInHarnessShared: one(benchmarkRolloutInHarnessShared, {
		fields: [benchmarkRunResultInHarnessShared.rolloutId],
		references: [benchmarkRolloutInHarnessShared.rolloutId]
	}),
}));

export const benchmarkRolloutInHarnessSharedRelations = relations(benchmarkRolloutInHarnessShared, ({many}) => ({
	benchmarkRunResultInHarnessShareds: many(benchmarkRunResultInHarnessShared),
}));

export const capabilityClassConformanceRunsInHarnessSharedRelations = relations(capabilityClassConformanceRunsInHarnessShared, ({one, many}) => ({
	capabilityClassRegistryInHarnessShared: one(capabilityClassRegistryInHarnessShared, {
		fields: [capabilityClassConformanceRunsInHarnessShared.workspaceId, capabilityClassConformanceRunsInHarnessShared.classId, capabilityClassConformanceRunsInHarnessShared.classVersion],
		references: [capabilityClassRegistryInHarnessShared.workspaceId, capabilityClassRegistryInHarnessShared.id, capabilityClassRegistryInHarnessShared.version]
	}),
	capabilityClassProviderBindingsInHarnessShareds: many(capabilityClassProviderBindingsInHarnessShared),
}));

export const capabilityClassRegistryInHarnessSharedRelations = relations(capabilityClassRegistryInHarnessShared, ({many}) => ({
	capabilityClassConformanceRunsInHarnessShareds: many(capabilityClassConformanceRunsInHarnessShared),
	capabilityClassProviderBindingsInHarnessShareds: many(capabilityClassProviderBindingsInHarnessShared),
}));

export const connectedAppAccessTokensInHarnessSharedRelations = relations(connectedAppAccessTokensInHarnessShared, ({one}) => ({
	connectedAppsInHarnessShared: one(connectedAppsInHarnessShared, {
		fields: [connectedAppAccessTokensInHarnessShared.appId],
		references: [connectedAppsInHarnessShared.id]
	}),
}));

export const connectedAppsInHarnessSharedRelations = relations(connectedAppsInHarnessShared, ({many}) => ({
	connectedAppAccessTokensInHarnessShareds: many(connectedAppAccessTokensInHarnessShared),
	connectedAppClientAssertionsInHarnessShareds: many(connectedAppClientAssertionsInHarnessShared),
	mobilePushTokensInHarnessShareds: many(mobilePushTokensInHarnessShared),
}));

export const connectedAppDeviceGrantsInHarnessSharedRelations = relations(connectedAppDeviceGrantsInHarnessShared, ({one}) => ({
	connectedAppOauthClientsInHarnessShared: one(connectedAppOauthClientsInHarnessShared, {
		fields: [connectedAppDeviceGrantsInHarnessShared.oauthClientId],
		references: [connectedAppOauthClientsInHarnessShared.clientId]
	}),
}));

export const connectedAppOauthClientsInHarnessSharedRelations = relations(connectedAppOauthClientsInHarnessShared, ({many}) => ({
	connectedAppDeviceGrantsInHarnessShareds: many(connectedAppDeviceGrantsInHarnessShared),
}));

export const coverageEvidenceInHarnessSharedRelations = relations(coverageEvidenceInHarnessShared, ({one}) => ({
	testingSurfacesInHarnessShared: one(testingSurfacesInHarnessShared, {
		fields: [coverageEvidenceInHarnessShared.surfaceRef],
		references: [testingSurfacesInHarnessShared.id]
	}),
	testRunsInHarnessShared: one(testRunsInHarnessShared, {
		fields: [coverageEvidenceInHarnessShared.testRunId],
		references: [testRunsInHarnessShared.id]
	}),
}));

export const testingSurfacesInHarnessSharedRelations = relations(testingSurfacesInHarnessShared, ({many}) => ({
	coverageEvidenceInHarnessShareds: many(coverageEvidenceInHarnessShared),
	coverageWaiversInHarnessShareds: many(coverageWaiversInHarnessShared),
}));

export const testRunsInHarnessSharedRelations = relations(testRunsInHarnessShared, ({many}) => ({
	coverageEvidenceInHarnessShareds: many(coverageEvidenceInHarnessShared),
}));

export const coverageWaiversInHarnessSharedRelations = relations(coverageWaiversInHarnessShared, ({one}) => ({
	testingSurfacesInHarnessShared: one(testingSurfacesInHarnessShared, {
		fields: [coverageWaiversInHarnessShared.surfaceRef],
		references: [testingSurfacesInHarnessShared.id]
	}),
}));

export const cupKeeperRunsInHarnessSharedRelations = relations(cupKeeperRunsInHarnessShared, ({one, many}) => ({
	cupKeeperInstancesInHarnessShared: one(cupKeeperInstancesInHarnessShared, {
		fields: [cupKeeperRunsInHarnessShared.instanceId],
		references: [cupKeeperInstancesInHarnessShared.instanceId]
	}),
	cupKeeperScoresInHarnessShareds: many(cupKeeperScoresInHarnessShared),
}));

export const cupKeeperInstancesInHarnessSharedRelations = relations(cupKeeperInstancesInHarnessShared, ({many}) => ({
	cupKeeperRunsInHarnessShareds: many(cupKeeperRunsInHarnessShared),
}));

export const eventAwaitNodesInHarnessSharedRelations = relations(eventAwaitNodesInHarnessShared, ({one, many}) => ({
	eventAwaitNodesInHarnessShared: one(eventAwaitNodesInHarnessShared, {
		fields: [eventAwaitNodesInHarnessShared.parentId],
		references: [eventAwaitNodesInHarnessShared.id],
		relationName: "eventAwaitNodesInHarnessShared_parentId_eventAwaitNodesInHarnessShared_id"
	}),
	eventAwaitNodesInHarnessShareds: many(eventAwaitNodesInHarnessShared, {
		relationName: "eventAwaitNodesInHarnessShared_parentId_eventAwaitNodesInHarnessShared_id"
	}),
}));

export const goalPotsInHarnessSharedRelations = relations(goalPotsInHarnessShared, ({one}) => ({
	goalsInHarnessShared: one(goalsInHarnessShared, {
		fields: [goalPotsInHarnessShared.goalId],
		references: [goalsInHarnessShared.id]
	}),
}));

export const goalsInHarnessSharedRelations = relations(goalsInHarnessShared, ({one, many}) => ({
	goalPotsInHarnessShareds: many(goalPotsInHarnessShared),
	goalsInHarnessShared: one(goalsInHarnessShared, {
		fields: [goalsInHarnessShared.parentId],
		references: [goalsInHarnessShared.id],
		relationName: "goalsInHarnessShared_parentId_goalsInHarnessShared_id"
	}),
	goalsInHarnessShareds: many(goalsInHarnessShared, {
		relationName: "goalsInHarnessShared_parentId_goalsInHarnessShared_id"
	}),
	triggerBindingsInHarnessShareds: many(triggerBindingsInHarnessShared),
}));

export const llmTestFindingsInHarnessSharedRelations = relations(llmTestFindingsInHarnessShared, ({one}) => ({
	llmTestRunsInHarnessShared: one(llmTestRunsInHarnessShared, {
		fields: [llmTestFindingsInHarnessShared.runId],
		references: [llmTestRunsInHarnessShared.id]
	}),
}));

export const llmTestRunsInHarnessSharedRelations = relations(llmTestRunsInHarnessShared, ({many}) => ({
	llmTestFindingsInHarnessShareds: many(llmTestFindingsInHarnessShared),
	llmTestFixturesInHarnessShareds: many(llmTestFixturesInHarnessShared),
}));

export const llmTestFixturesInHarnessSharedRelations = relations(llmTestFixturesInHarnessShared, ({one}) => ({
	llmTestRunsInHarnessShared: one(llmTestRunsInHarnessShared, {
		fields: [llmTestFixturesInHarnessShared.recordedFromRunId],
		references: [llmTestRunsInHarnessShared.id]
	}),
}));

export const memoryPrecisionBenchAttemptsInHarnessSharedRelations = relations(memoryPrecisionBenchAttemptsInHarnessShared, ({one}) => ({
	memoryPrecisionBenchInHarnessShared: one(memoryPrecisionBenchInHarnessShared, {
		fields: [memoryPrecisionBenchAttemptsInHarnessShared.rowId],
		references: [memoryPrecisionBenchInHarnessShared.id]
	}),
}));

export const memoryPrecisionBenchInHarnessSharedRelations = relations(memoryPrecisionBenchInHarnessShared, ({many}) => ({
	memoryPrecisionBenchAttemptsInHarnessShareds: many(memoryPrecisionBenchAttemptsInHarnessShared),
}));

export const memoryRecallQueryTextInHarnessSharedRelations = relations(memoryRecallQueryTextInHarnessShared, ({one}) => ({
	memoryRecallStatsInHarnessShared: one(memoryRecallStatsInHarnessShared, {
		fields: [memoryRecallQueryTextInHarnessShared.statsId],
		references: [memoryRecallStatsInHarnessShared.id]
	}),
}));

export const memoryRecallStatsInHarnessSharedRelations = relations(memoryRecallStatsInHarnessShared, ({many}) => ({
	memoryRecallQueryTextInHarnessShareds: many(memoryRecallQueryTextInHarnessShared),
}));

export const memoryVecGemmaInHarnessSharedRelations = relations(memoryVecGemmaInHarnessShared, ({one}) => ({
	memoryCanonicalInHarnessShared: one(memoryCanonicalInHarnessShared, {
		fields: [memoryVecGemmaInHarnessShared.memoryId],
		references: [memoryCanonicalInHarnessShared.id]
	}),
}));

export const memoryCanonicalInHarnessSharedRelations = relations(memoryCanonicalInHarnessShared, ({many}) => ({
	memoryVecGemmaInHarnessShareds: many(memoryVecGemmaInHarnessShared),
	memoryVecHarrierInHarnessShareds: many(memoryVecHarrierInHarnessShared),
	memoryVecLocalInHarnessShareds: many(memoryVecLocalInHarnessShared),
	memoryVecOpenaiInHarnessShareds: many(memoryVecOpenaiInHarnessShared),
	memoryAnchorsInHarnessShareds: many(memoryAnchorsInHarnessShared),
}));

export const memoryVecHarrierInHarnessSharedRelations = relations(memoryVecHarrierInHarnessShared, ({one}) => ({
	memoryCanonicalInHarnessShared: one(memoryCanonicalInHarnessShared, {
		fields: [memoryVecHarrierInHarnessShared.memoryId],
		references: [memoryCanonicalInHarnessShared.id]
	}),
}));

export const memoryVecLocalInHarnessSharedRelations = relations(memoryVecLocalInHarnessShared, ({one}) => ({
	memoryCanonicalInHarnessShared: one(memoryCanonicalInHarnessShared, {
		fields: [memoryVecLocalInHarnessShared.memoryId],
		references: [memoryCanonicalInHarnessShared.id]
	}),
}));

export const memoryVecOpenaiInHarnessSharedRelations = relations(memoryVecOpenaiInHarnessShared, ({one}) => ({
	memoryCanonicalInHarnessShared: one(memoryCanonicalInHarnessShared, {
		fields: [memoryVecOpenaiInHarnessShared.memoryId],
		references: [memoryCanonicalInHarnessShared.id]
	}),
}));

export const operatorTurnsInHarnessSharedRelations = relations(operatorTurnsInHarnessShared, ({one}) => ({
	operatorConversationsInHarnessShared: one(operatorConversationsInHarnessShared, {
		fields: [operatorTurnsInHarnessShared.conversationId],
		references: [operatorConversationsInHarnessShared.id]
	}),
}));

export const operatorConversationsInHarnessSharedRelations = relations(operatorConversationsInHarnessShared, ({many}) => ({
	operatorTurnsInHarnessShareds: many(operatorTurnsInHarnessShared),
}));

export const planRunTurnsInHarnessSharedRelations = relations(planRunTurnsInHarnessShared, ({one}) => ({
	planRunsInHarnessShared: one(planRunsInHarnessShared, {
		fields: [planRunTurnsInHarnessShared.planRunId],
		references: [planRunsInHarnessShared.id]
	}),
}));

export const planRunsInHarnessSharedRelations = relations(planRunsInHarnessShared, ({many}) => ({
	planRunTurnsInHarnessShareds: many(planRunTurnsInHarnessShared),
}));

export const potEvalRunsInHarnessSharedRelations = relations(potEvalRunsInHarnessShared, ({one, many}) => ({
	potEvalInstancesInHarnessShared: one(potEvalInstancesInHarnessShared, {
		fields: [potEvalRunsInHarnessShared.instanceId],
		references: [potEvalInstancesInHarnessShared.instanceId]
	}),
	potEvalScoresInHarnessShareds: many(potEvalScoresInHarnessShared),
}));

export const potEvalInstancesInHarnessSharedRelations = relations(potEvalInstancesInHarnessShared, ({many}) => ({
	potEvalRunsInHarnessShareds: many(potEvalRunsInHarnessShared),
}));

export const projectSpecRevisionsInHarnessSharedRelations = relations(projectSpecRevisionsInHarnessShared, ({one}) => ({
	projectsInHarnessShared: one(projectsInHarnessShared, {
		fields: [projectSpecRevisionsInHarnessShared.projectId],
		references: [projectsInHarnessShared.id]
	}),
}));

export const projectsInHarnessSharedRelations = relations(projectsInHarnessShared, ({many}) => ({
	projectSpecRevisionsInHarnessShareds: many(projectSpecRevisionsInHarnessShared),
}));

export const routinesInHarnessSharedRelations = relations(routinesInHarnessShared, ({one}) => ({
	routineGroupsInHarnessShared: one(routineGroupsInHarnessShared, {
		fields: [routinesInHarnessShared.workspaceId, routinesInHarnessShared.groupSlug],
		references: [routineGroupsInHarnessShared.workspaceId, routineGroupsInHarnessShared.slug]
	}),
}));

export const routineGroupsInHarnessSharedRelations = relations(routineGroupsInHarnessShared, ({many}) => ({
	routinesInHarnessShareds: many(routinesInHarnessShared),
}));

export const savedPromptsInHarnessSharedRelations = relations(savedPromptsInHarnessShared, ({one, many}) => ({
	savedPromptsInHarnessShared: one(savedPromptsInHarnessShared, {
		fields: [savedPromptsInHarnessShared.parentId],
		references: [savedPromptsInHarnessShared.id],
		relationName: "savedPromptsInHarnessShared_parentId_savedPromptsInHarnessShared_id"
	}),
	savedPromptsInHarnessShareds: many(savedPromptsInHarnessShared, {
		relationName: "savedPromptsInHarnessShared_parentId_savedPromptsInHarnessShared_id"
	}),
}));

export const specEvidenceBindingsInHarnessSharedRelations = relations(specEvidenceBindingsInHarnessShared, ({one}) => ({
	workItemSpecRevisionEdgesInHarnessShared: one(workItemSpecRevisionEdgesInHarnessShared, {
		fields: [specEvidenceBindingsInHarnessShared.workspaceId, specEvidenceBindingsInHarnessShared.harnessSlug, specEvidenceBindingsInHarnessShared.workItemId, specEvidenceBindingsInHarnessShared.planSlug, specEvidenceBindingsInHarnessShared.specId, specEvidenceBindingsInHarnessShared.specRevision, specEvidenceBindingsInHarnessShared.specFingerprint],
		references: [workItemSpecRevisionEdgesInHarnessShared.workspaceId, workItemSpecRevisionEdgesInHarnessShared.harnessSlug, workItemSpecRevisionEdgesInHarnessShared.workItemId, workItemSpecRevisionEdgesInHarnessShared.planSlug, workItemSpecRevisionEdgesInHarnessShared.specId, workItemSpecRevisionEdgesInHarnessShared.specRevision, workItemSpecRevisionEdgesInHarnessShared.specFingerprint]
	}),
}));

export const workItemSpecRevisionEdgesInHarnessSharedRelations = relations(workItemSpecRevisionEdgesInHarnessShared, ({one, many}) => ({
	specEvidenceBindingsInHarnessShareds: many(specEvidenceBindingsInHarnessShared),
	planSpecClauseRevisionsInHarnessShared: one(planSpecClauseRevisionsInHarnessShared, {
		fields: [workItemSpecRevisionEdgesInHarnessShared.workspaceId, workItemSpecRevisionEdgesInHarnessShared.harnessSlug, workItemSpecRevisionEdgesInHarnessShared.planSlug, workItemSpecRevisionEdgesInHarnessShared.specId, workItemSpecRevisionEdgesInHarnessShared.specRevision, workItemSpecRevisionEdgesInHarnessShared.specFingerprint],
		references: [planSpecClauseRevisionsInHarnessShared.workspaceId, planSpecClauseRevisionsInHarnessShared.harnessSlug, planSpecClauseRevisionsInHarnessShared.planSlug, planSpecClauseRevisionsInHarnessShared.specId, planSpecClauseRevisionsInHarnessShared.revision, planSpecClauseRevisionsInHarnessShared.contentHash]
	}),
	workItemsInHarnessShared: one(workItemsInHarnessShared, {
		fields: [workItemSpecRevisionEdgesInHarnessShared.workspaceId, workItemSpecRevisionEdgesInHarnessShared.harnessSlug, workItemSpecRevisionEdgesInHarnessShared.workItemId],
		references: [workItemsInHarnessShared.workspaceId, workItemsInHarnessShared.harnessSlug, workItemsInHarnessShared.featureId]
	}),
}));

export const userSessionsInHarnessSharedRelations = relations(userSessionsInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [userSessionsInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const usersInHarnessSharedRelations = relations(usersInHarnessShared, ({many}) => ({
	userSessionsInHarnessShareds: many(userSessionsInHarnessShared),
	userPreferencesInHarnessShareds: many(userPreferencesInHarnessShared),
	personalVaultSettingsInHarnessShareds: many(personalVaultSettingsInHarnessShared),
	appOwnerMappingsInHarnessShareds: many(appOwnerMappingsInHarnessShared),
	personalSyncStateInHarnessShareds: many(personalSyncStateInHarnessShared),
	personalIdentitiesInHarnessShareds: many(personalIdentitiesInHarnessShared),
	personalGrantsInHarnessShareds: many(personalGrantsInHarnessShared),
	personalVaultImportUploadsInHarnessShareds: many(personalVaultImportUploadsInHarnessShared),
	triggerSourcesInHarnessShareds: many(triggerSourcesInHarnessShared),
	personalDocumentsInHarnessShareds: many(personalDocumentsInHarnessShared),
	personalVaultImportJobsInHarnessShareds: many(personalVaultImportJobsInHarnessShared),
}));

export const messageCommentsInPapercuspSharedRelations = relations(messageCommentsInPapercuspShared, ({one}) => ({
	messagesInPapercuspShared: one(messagesInPapercuspShared, {
		fields: [messageCommentsInPapercuspShared.messageId],
		references: [messagesInPapercuspShared.id]
	}),
}));

export const messagesInPapercuspSharedRelations = relations(messagesInPapercuspShared, ({many}) => ({
	messageCommentsInPapercuspShareds: many(messageCommentsInPapercuspShared),
	messageRecipientsInPapercuspShareds: many(messageRecipientsInPapercuspShared),
}));

export const messageRecipientsInPapercuspSharedRelations = relations(messageRecipientsInPapercuspShared, ({one}) => ({
	messagesInPapercuspShared: one(messagesInPapercuspShared, {
		fields: [messageRecipientsInPapercuspShared.messageId],
		references: [messagesInPapercuspShared.id]
	}),
}));

export const connectedAppClientAssertionsInHarnessSharedRelations = relations(connectedAppClientAssertionsInHarnessShared, ({one}) => ({
	connectedAppsInHarnessShared: one(connectedAppsInHarnessShared, {
		fields: [connectedAppClientAssertionsInHarnessShared.appId],
		references: [connectedAppsInHarnessShared.id]
	}),
}));

export const mobilePushTokensInHarnessSharedRelations = relations(mobilePushTokensInHarnessShared, ({one}) => ({
	connectedAppsInHarnessShared: one(connectedAppsInHarnessShared, {
		fields: [mobilePushTokensInHarnessShared.deviceId],
		references: [connectedAppsInHarnessShared.id]
	}),
}));

export const userPreferencesInHarnessSharedRelations = relations(userPreferencesInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [userPreferencesInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const blueprintPackageDependentsInHarnessSharedRelations = relations(blueprintPackageDependentsInHarnessShared, ({one}) => ({
	blueprintPackageResourcesInHarnessShared: one(blueprintPackageResourcesInHarnessShared, {
		fields: [blueprintPackageDependentsInHarnessShared.workspaceId, blueprintPackageDependentsInHarnessShared.resourceKey],
		references: [blueprintPackageResourcesInHarnessShared.workspaceId, blueprintPackageResourcesInHarnessShared.resourceKey]
	}),
}));

export const blueprintPackageResourcesInHarnessSharedRelations = relations(blueprintPackageResourcesInHarnessShared, ({many}) => ({
	blueprintPackageDependentsInHarnessShareds: many(blueprintPackageDependentsInHarnessShared),
}));

export const personalVaultSettingsInHarnessSharedRelations = relations(personalVaultSettingsInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [personalVaultSettingsInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const memoryAnchorsInHarnessSharedRelations = relations(memoryAnchorsInHarnessShared, ({one}) => ({
	memoryCanonicalInHarnessShared: one(memoryCanonicalInHarnessShared, {
		fields: [memoryAnchorsInHarnessShared.memoryId],
		references: [memoryCanonicalInHarnessShared.id]
	}),
}));

export const appOwnerMappingsInHarnessSharedRelations = relations(appOwnerMappingsInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [appOwnerMappingsInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const personalSyncStateInHarnessSharedRelations = relations(personalSyncStateInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [personalSyncStateInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const sessionTaskWorkItemLinksInHarnessSharedRelations = relations(sessionTaskWorkItemLinksInHarnessShared, ({one}) => ({
	sessionTasksInHarnessShared: one(sessionTasksInHarnessShared, {
		fields: [sessionTaskWorkItemLinksInHarnessShared.workspaceId, sessionTaskWorkItemLinksInHarnessShared.sessionId, sessionTaskWorkItemLinksInHarnessShared.taskId],
		references: [sessionTasksInHarnessShared.workspaceId, sessionTasksInHarnessShared.sessionId, sessionTasksInHarnessShared.taskId]
	}),
}));

export const sessionTasksInHarnessSharedRelations = relations(sessionTasksInHarnessShared, ({many}) => ({
	sessionTaskWorkItemLinksInHarnessShareds: many(sessionTaskWorkItemLinksInHarnessShared),
}));

export const personalIdentitiesInHarnessSharedRelations = relations(personalIdentitiesInHarnessShared, ({one, many}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [personalIdentitiesInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
	personalIdentityAliasesInHarnessShareds: many(personalIdentityAliasesInHarnessShared),
}));

export const reportLibraryChunksInHarnessSharedRelations = relations(reportLibraryChunksInHarnessShared, ({one}) => ({
	reportLibraryInHarnessShared: one(reportLibraryInHarnessShared, {
		fields: [reportLibraryChunksInHarnessShared.workspaceId, reportLibraryChunksInHarnessShared.reportId],
		references: [reportLibraryInHarnessShared.workspaceId, reportLibraryInHarnessShared.reportId]
	}),
}));

export const reportLibraryInHarnessSharedRelations = relations(reportLibraryInHarnessShared, ({many}) => ({
	reportLibraryChunksInHarnessShareds: many(reportLibraryChunksInHarnessShared),
}));

export const planSpecClausesInHarnessSharedRelations = relations(planSpecClausesInHarnessShared, ({one, many}) => ({
	planSpecClauseRevisionsInHarnessShared: one(planSpecClauseRevisionsInHarnessShared, {
		fields: [planSpecClausesInHarnessShared.workspaceId, planSpecClausesInHarnessShared.harnessSlug, planSpecClausesInHarnessShared.planSlug, planSpecClausesInHarnessShared.specId, planSpecClausesInHarnessShared.currentRevision],
		references: [planSpecClauseRevisionsInHarnessShared.workspaceId, planSpecClauseRevisionsInHarnessShared.harnessSlug, planSpecClauseRevisionsInHarnessShared.planSlug, planSpecClauseRevisionsInHarnessShared.specId, planSpecClauseRevisionsInHarnessShared.revision],
		relationName: "planSpecClausesInHarnessShared_workspaceId_planSpecClauseRevisionsInHarnessShared_workspaceId"
	}),
	harnessPlansInHarnessShared: one(harnessPlansInHarnessShared, {
		fields: [planSpecClausesInHarnessShared.workspaceId, planSpecClausesInHarnessShared.harnessSlug, planSpecClausesInHarnessShared.planSlug],
		references: [harnessPlansInHarnessShared.workspaceId, harnessPlansInHarnessShared.harnessSlug, harnessPlansInHarnessShared.planSlug]
	}),
	planSpecClauseRevisionsInHarnessShareds: many(planSpecClauseRevisionsInHarnessShared, {
		relationName: "planSpecClauseRevisionsInHarnessShared_workspaceId_planSpecClausesInHarnessShared_workspaceId"
	}),
}));

export const planSpecClauseRevisionsInHarnessSharedRelations = relations(planSpecClauseRevisionsInHarnessShared, ({one, many}) => ({
	planSpecClausesInHarnessShareds: many(planSpecClausesInHarnessShared, {
		relationName: "planSpecClausesInHarnessShared_workspaceId_planSpecClauseRevisionsInHarnessShared_workspaceId"
	}),
	workItemSpecRevisionEdgesInHarnessShareds: many(workItemSpecRevisionEdgesInHarnessShared),
	planSpecClauseRevisionsInHarnessShared: one(planSpecClauseRevisionsInHarnessShared, {
		fields: [planSpecClauseRevisionsInHarnessShared.workspaceId, planSpecClauseRevisionsInHarnessShared.harnessSlug, planSpecClauseRevisionsInHarnessShared.planSlug, planSpecClauseRevisionsInHarnessShared.supersedesSpecId, planSpecClauseRevisionsInHarnessShared.supersedesRevision],
		references: [planSpecClauseRevisionsInHarnessShared.workspaceId, planSpecClauseRevisionsInHarnessShared.harnessSlug, planSpecClauseRevisionsInHarnessShared.planSlug, planSpecClauseRevisionsInHarnessShared.specId, planSpecClauseRevisionsInHarnessShared.revision],
		relationName: "planSpecClauseRevisionsInHarnessShared_workspaceId_planSpecClauseRevisionsInHarnessShared_workspaceId"
	}),
	planSpecClauseRevisionsInHarnessShareds: many(planSpecClauseRevisionsInHarnessShared, {
		relationName: "planSpecClauseRevisionsInHarnessShared_workspaceId_planSpecClauseRevisionsInHarnessShared_workspaceId"
	}),
	planSpecClausesInHarnessShared: one(planSpecClausesInHarnessShared, {
		fields: [planSpecClauseRevisionsInHarnessShared.workspaceId, planSpecClauseRevisionsInHarnessShared.harnessSlug, planSpecClauseRevisionsInHarnessShared.planSlug, planSpecClauseRevisionsInHarnessShared.specId],
		references: [planSpecClausesInHarnessShared.workspaceId, planSpecClausesInHarnessShared.harnessSlug, planSpecClausesInHarnessShared.planSlug, planSpecClausesInHarnessShared.specId],
		relationName: "planSpecClauseRevisionsInHarnessShared_workspaceId_planSpecClausesInHarnessShared_workspaceId"
	}),
}));

export const harnessPlansInHarnessSharedRelations = relations(harnessPlansInHarnessShared, ({many}) => ({
	planSpecClausesInHarnessShareds: many(planSpecClausesInHarnessShared),
	planDecisionsInHarnessShareds: many(planDecisionsInHarnessShared),
	planItemsInHarnessShareds: many(planItemsInHarnessShared),
	triggerBindingsInHarnessShareds: many(triggerBindingsInHarnessShared),
}));

export const workItemsInHarnessSharedRelations = relations(workItemsInHarnessShared, ({many}) => ({
	workItemSpecRevisionEdgesInHarnessShareds: many(workItemSpecRevisionEdgesInHarnessShared),
}));

export const personalIdentityAliasesInHarnessSharedRelations = relations(personalIdentityAliasesInHarnessShared, ({one}) => ({
	personalIdentitiesInHarnessShared: one(personalIdentitiesInHarnessShared, {
		fields: [personalIdentityAliasesInHarnessShared.workspaceId, personalIdentityAliasesInHarnessShared.userId, personalIdentityAliasesInHarnessShared.identityId],
		references: [personalIdentitiesInHarnessShared.workspaceId, personalIdentitiesInHarnessShared.userId, personalIdentitiesInHarnessShared.id]
	}),
}));

export const workspaceHostLogsInHarnessSharedRelations = relations(workspaceHostLogsInHarnessShared, ({one}) => ({
	workspaceHostsInHarnessShared: one(workspaceHostsInHarnessShared, {
		fields: [workspaceHostLogsInHarnessShared.workspaceId, workspaceHostLogsInHarnessShared.hostId],
		references: [workspaceHostsInHarnessShared.workspaceId, workspaceHostsInHarnessShared.id]
	}),
	workspaceHostOperationsInHarnessShared: one(workspaceHostOperationsInHarnessShared, {
		fields: [workspaceHostLogsInHarnessShared.workspaceId, workspaceHostLogsInHarnessShared.operationId],
		references: [workspaceHostOperationsInHarnessShared.workspaceId, workspaceHostOperationsInHarnessShared.id]
	}),
}));

export const workspaceHostsInHarnessSharedRelations = relations(workspaceHostsInHarnessShared, ({one, many}) => ({
	workspaceHostLogsInHarnessShareds: many(workspaceHostLogsInHarnessShared),
	workspaceHostEventsInHarnessShareds: many(workspaceHostEventsInHarnessShared),
	workspaceHostInitializationStepsInHarnessShareds: many(workspaceHostInitializationStepsInHarnessShared),
	workspaceHostResourcesInHarnessShareds: many(workspaceHostResourcesInHarnessShared),
	customerWorkspacesInHarnessShareds: many(customerWorkspacesInHarnessShared),
	workspaceHostConnectionsInHarnessShared: one(workspaceHostConnectionsInHarnessShared, {
		fields: [workspaceHostsInHarnessShared.workspaceId, workspaceHostsInHarnessShared.connectionId],
		references: [workspaceHostConnectionsInHarnessShared.workspaceId, workspaceHostConnectionsInHarnessShared.id]
	}),
	workspaceHostOperationsInHarnessShareds: many(workspaceHostOperationsInHarnessShared),
}));

export const workspaceHostOperationsInHarnessSharedRelations = relations(workspaceHostOperationsInHarnessShared, ({one, many}) => ({
	workspaceHostLogsInHarnessShareds: many(workspaceHostLogsInHarnessShared),
	workspaceHostEventsInHarnessShareds: many(workspaceHostEventsInHarnessShared),
	workspaceHostResourcesInHarnessShareds: many(workspaceHostResourcesInHarnessShared),
	customerWorkspacesInHarnessShared: one(customerWorkspacesInHarnessShared, {
		fields: [workspaceHostOperationsInHarnessShared.workspaceId, workspaceHostOperationsInHarnessShared.organizationId, workspaceHostOperationsInHarnessShared.customerWorkspaceId],
		references: [customerWorkspacesInHarnessShared.workspaceId, customerWorkspacesInHarnessShared.organizationId, customerWorkspacesInHarnessShared.id]
	}),
	workspaceHostsInHarnessShared: one(workspaceHostsInHarnessShared, {
		fields: [workspaceHostOperationsInHarnessShared.workspaceId, workspaceHostOperationsInHarnessShared.hostId],
		references: [workspaceHostsInHarnessShared.workspaceId, workspaceHostsInHarnessShared.id]
	}),
}));

export const personalGrantsInHarnessSharedRelations = relations(personalGrantsInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [personalGrantsInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const personalVaultImportUploadsInHarnessSharedRelations = relations(personalVaultImportUploadsInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [personalVaultImportUploadsInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const planDecisionsInHarnessSharedRelations = relations(planDecisionsInHarnessShared, ({one}) => ({
	harnessPlansInHarnessShared: one(harnessPlansInHarnessShared, {
		fields: [planDecisionsInHarnessShared.workspaceId, planDecisionsInHarnessShared.harnessSlug, planDecisionsInHarnessShared.planSlug],
		references: [harnessPlansInHarnessShared.workspaceId, harnessPlansInHarnessShared.harnessSlug, harnessPlansInHarnessShared.planSlug]
	}),
}));

export const potCapabilityClassBindingsInHarnessSharedRelations = relations(potCapabilityClassBindingsInHarnessShared, ({one}) => ({
	capabilityClassProviderBindingsInHarnessShared: one(capabilityClassProviderBindingsInHarnessShared, {
		fields: [potCapabilityClassBindingsInHarnessShared.workspaceId, potCapabilityClassBindingsInHarnessShared.classId, potCapabilityClassBindingsInHarnessShared.classVersion, potCapabilityClassBindingsInHarnessShared.providerPackage, potCapabilityClassBindingsInHarnessShared.providerVersion, potCapabilityClassBindingsInHarnessShared.providerKind, potCapabilityClassBindingsInHarnessShared.latencyClass],
		references: [capabilityClassProviderBindingsInHarnessShared.workspaceId, capabilityClassProviderBindingsInHarnessShared.classId, capabilityClassProviderBindingsInHarnessShared.classVersion, capabilityClassProviderBindingsInHarnessShared.providerPackage, capabilityClassProviderBindingsInHarnessShared.providerVersion, capabilityClassProviderBindingsInHarnessShared.providerKind, capabilityClassProviderBindingsInHarnessShared.latencyClass]
	}),
}));

export const capabilityClassProviderBindingsInHarnessSharedRelations = relations(capabilityClassProviderBindingsInHarnessShared, ({one, many}) => ({
	potCapabilityClassBindingsInHarnessShareds: many(potCapabilityClassBindingsInHarnessShared),
	capabilityClassRegistryInHarnessShared: one(capabilityClassRegistryInHarnessShared, {
		fields: [capabilityClassProviderBindingsInHarnessShared.workspaceId, capabilityClassProviderBindingsInHarnessShared.classId, capabilityClassProviderBindingsInHarnessShared.classVersion],
		references: [capabilityClassRegistryInHarnessShared.workspaceId, capabilityClassRegistryInHarnessShared.id, capabilityClassRegistryInHarnessShared.version]
	}),
	capabilityClassConformanceRunsInHarnessShared: one(capabilityClassConformanceRunsInHarnessShared, {
		fields: [capabilityClassProviderBindingsInHarnessShared.workspaceId, capabilityClassProviderBindingsInHarnessShared.classId, capabilityClassProviderBindingsInHarnessShared.classVersion, capabilityClassProviderBindingsInHarnessShared.providerPackage, capabilityClassProviderBindingsInHarnessShared.providerVersion, capabilityClassProviderBindingsInHarnessShared.conformanceRunId, capabilityClassProviderBindingsInHarnessShared.bindingEligible, capabilityClassProviderBindingsInHarnessShared.providerKind, capabilityClassProviderBindingsInHarnessShared.latencyClass],
		references: [capabilityClassConformanceRunsInHarnessShared.workspaceId, capabilityClassConformanceRunsInHarnessShared.classId, capabilityClassConformanceRunsInHarnessShared.classVersion, capabilityClassConformanceRunsInHarnessShared.providerPackage, capabilityClassConformanceRunsInHarnessShared.providerVersion, capabilityClassConformanceRunsInHarnessShared.id, capabilityClassConformanceRunsInHarnessShared.structuralPassed, capabilityClassConformanceRunsInHarnessShared.providerKind, capabilityClassConformanceRunsInHarnessShared.latencyClass]
	}),
}));

export const sessionTurnChunksInHarnessSharedRelations = relations(sessionTurnChunksInHarnessShared, ({one}) => ({
	sessionTurnsInHarnessShared: one(sessionTurnsInHarnessShared, {
		fields: [sessionTurnChunksInHarnessShared.workspaceId, sessionTurnChunksInHarnessShared.sourceKind, sessionTurnChunksInHarnessShared.sessionId, sessionTurnChunksInHarnessShared.turnIdx],
		references: [sessionTurnsInHarnessShared.workspaceId, sessionTurnsInHarnessShared.sourceKind, sessionTurnsInHarnessShared.sessionId, sessionTurnsInHarnessShared.turnIdx]
	}),
}));

export const sessionTurnsInHarnessSharedRelations = relations(sessionTurnsInHarnessShared, ({many}) => ({
	sessionTurnChunksInHarnessShareds: many(sessionTurnChunksInHarnessShared),
}));

export const workspaceHostEventsInHarnessSharedRelations = relations(workspaceHostEventsInHarnessShared, ({one}) => ({
	workspaceHostsInHarnessShared: one(workspaceHostsInHarnessShared, {
		fields: [workspaceHostEventsInHarnessShared.workspaceId, workspaceHostEventsInHarnessShared.hostId],
		references: [workspaceHostsInHarnessShared.workspaceId, workspaceHostsInHarnessShared.id]
	}),
	workspaceHostOperationsInHarnessShared: one(workspaceHostOperationsInHarnessShared, {
		fields: [workspaceHostEventsInHarnessShared.workspaceId, workspaceHostEventsInHarnessShared.operationId],
		references: [workspaceHostOperationsInHarnessShared.workspaceId, workspaceHostOperationsInHarnessShared.id]
	}),
}));

export const workspaceHostInitializationStepsInHarnessSharedRelations = relations(workspaceHostInitializationStepsInHarnessShared, ({one}) => ({
	workspaceHostsInHarnessShared: one(workspaceHostsInHarnessShared, {
		fields: [workspaceHostInitializationStepsInHarnessShared.workspaceId, workspaceHostInitializationStepsInHarnessShared.hostId],
		references: [workspaceHostsInHarnessShared.workspaceId, workspaceHostsInHarnessShared.id]
	}),
}));

export const planItemsInHarnessSharedRelations = relations(planItemsInHarnessShared, ({one}) => ({
	harnessPlansInHarnessShared: one(harnessPlansInHarnessShared, {
		fields: [planItemsInHarnessShared.workspaceId, planItemsInHarnessShared.harnessSlug, planItemsInHarnessShared.planSlug],
		references: [harnessPlansInHarnessShared.workspaceId, harnessPlansInHarnessShared.harnessSlug, harnessPlansInHarnessShared.planSlug]
	}),
}));

export const triggerSourcesInHarnessSharedRelations = relations(triggerSourcesInHarnessShared, ({one, many}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [triggerSourcesInHarnessShared.ownerUserId],
		references: [usersInHarnessShared.id]
	}),
	triggerDeliveriesInHarnessShareds: many(triggerDeliveriesInHarnessShared),
	triggerBindingsInHarnessShareds: many(triggerBindingsInHarnessShared),
}));

export const potEvalScoresInHarnessSharedRelations = relations(potEvalScoresInHarnessShared, ({one}) => ({
	potEvalRunsInHarnessShared: one(potEvalRunsInHarnessShared, {
		fields: [potEvalScoresInHarnessShared.runId],
		references: [potEvalRunsInHarnessShared.runId]
	}),
}));

export const triggerDeliveriesInHarnessSharedRelations = relations(triggerDeliveriesInHarnessShared, ({one, many}) => ({
	datatypeRegistryInHarnessShared: one(datatypeRegistryInHarnessShared, {
		fields: [triggerDeliveriesInHarnessShared.workspaceId, triggerDeliveriesInHarnessShared.datatypeId],
		references: [datatypeRegistryInHarnessShared.workspaceId, datatypeRegistryInHarnessShared.id]
	}),
	triggerSourcesInHarnessShared: one(triggerSourcesInHarnessShared, {
		fields: [triggerDeliveriesInHarnessShared.workspaceId, triggerDeliveriesInHarnessShared.sourceId],
		references: [triggerSourcesInHarnessShared.workspaceId, triggerSourcesInHarnessShared.id]
	}),
	triggerRunsInHarnessShareds: many(triggerRunsInHarnessShared),
}));

export const datatypeRegistryInHarnessSharedRelations = relations(datatypeRegistryInHarnessShared, ({many}) => ({
	triggerDeliveriesInHarnessShareds: many(triggerDeliveriesInHarnessShared),
}));

export const triggerRunsInHarnessSharedRelations = relations(triggerRunsInHarnessShared, ({one}) => ({
	triggerBindingsInHarnessShared: one(triggerBindingsInHarnessShared, {
		fields: [triggerRunsInHarnessShared.workspaceId, triggerRunsInHarnessShared.bindingId],
		references: [triggerBindingsInHarnessShared.workspaceId, triggerBindingsInHarnessShared.id]
	}),
	triggerDeliveriesInHarnessShared: one(triggerDeliveriesInHarnessShared, {
		fields: [triggerRunsInHarnessShared.workspaceId, triggerRunsInHarnessShared.deliveryId],
		references: [triggerDeliveriesInHarnessShared.workspaceId, triggerDeliveriesInHarnessShared.id]
	}),
}));

export const triggerBindingsInHarnessSharedRelations = relations(triggerBindingsInHarnessShared, ({one, many}) => ({
	triggerRunsInHarnessShareds: many(triggerRunsInHarnessShared),
	goalsInHarnessShared: one(goalsInHarnessShared, {
		fields: [triggerBindingsInHarnessShared.goalId],
		references: [goalsInHarnessShared.id]
	}),
	harnessPlansInHarnessShared: one(harnessPlansInHarnessShared, {
		fields: [triggerBindingsInHarnessShared.workspaceId, triggerBindingsInHarnessShared.planHarnessSlug, triggerBindingsInHarnessShared.planSlug],
		references: [harnessPlansInHarnessShared.workspaceId, harnessPlansInHarnessShared.harnessSlug, harnessPlansInHarnessShared.planSlug]
	}),
	triggerSourcesInHarnessShared: one(triggerSourcesInHarnessShared, {
		fields: [triggerBindingsInHarnessShared.workspaceId, triggerBindingsInHarnessShared.sourceId],
		references: [triggerSourcesInHarnessShared.workspaceId, triggerSourcesInHarnessShared.id]
	}),
}));

export const benchRunTasksInHarnessSharedRelations = relations(benchRunTasksInHarnessShared, ({one}) => ({
	benchRunsInHarnessShared: one(benchRunsInHarnessShared, {
		fields: [benchRunTasksInHarnessShared.runId],
		references: [benchRunsInHarnessShared.id]
	}),
}));

export const cupKeeperScoresInHarnessSharedRelations = relations(cupKeeperScoresInHarnessShared, ({one}) => ({
	cupKeeperRunsInHarnessShared: one(cupKeeperRunsInHarnessShared, {
		fields: [cupKeeperScoresInHarnessShared.runId],
		references: [cupKeeperRunsInHarnessShared.runId]
	}),
}));

export const workspaceHostResourcesInHarnessSharedRelations = relations(workspaceHostResourcesInHarnessShared, ({one}) => ({
	workspaceHostsInHarnessShared: one(workspaceHostsInHarnessShared, {
		fields: [workspaceHostResourcesInHarnessShared.workspaceId, workspaceHostResourcesInHarnessShared.hostId],
		references: [workspaceHostsInHarnessShared.workspaceId, workspaceHostsInHarnessShared.id]
	}),
	workspaceHostOperationsInHarnessShared: one(workspaceHostOperationsInHarnessShared, {
		fields: [workspaceHostResourcesInHarnessShared.workspaceId, workspaceHostResourcesInHarnessShared.operationId],
		references: [workspaceHostOperationsInHarnessShared.workspaceId, workspaceHostOperationsInHarnessShared.id]
	}),
}));

export const workspaceGrantsInHarnessSharedRelations = relations(workspaceGrantsInHarnessShared, ({one}) => ({
	customerWorkspacesInHarnessShared: one(customerWorkspacesInHarnessShared, {
		fields: [workspaceGrantsInHarnessShared.workspaceId, workspaceGrantsInHarnessShared.organizationId, workspaceGrantsInHarnessShared.customerWorkspaceId],
		references: [customerWorkspacesInHarnessShared.workspaceId, customerWorkspacesInHarnessShared.organizationId, customerWorkspacesInHarnessShared.id]
	}),
}));

export const customerWorkspacesInHarnessSharedRelations = relations(customerWorkspacesInHarnessShared, ({one, many}) => ({
	workspaceGrantsInHarnessShareds: many(workspaceGrantsInHarnessShared),
	workspaceHostsInHarnessShared: one(workspaceHostsInHarnessShared, {
		fields: [customerWorkspacesInHarnessShared.workspaceId, customerWorkspacesInHarnessShared.workspaceHostId],
		references: [workspaceHostsInHarnessShared.workspaceId, workspaceHostsInHarnessShared.id]
	}),
	workspaceHostOperationsInHarnessShareds: many(workspaceHostOperationsInHarnessShared),
}));

export const triageLedgerInHarnessSharedRelations = relations(triageLedgerInHarnessShared, ({one}) => ({
	triageSnapshotsInHarnessShared: one(triageSnapshotsInHarnessShared, {
		fields: [triageLedgerInHarnessShared.snapshotId],
		references: [triageSnapshotsInHarnessShared.snapshotId]
	}),
}));

export const triageSnapshotsInHarnessSharedRelations = relations(triageSnapshotsInHarnessShared, ({many}) => ({
	triageLedgerInHarnessShareds: many(triageLedgerInHarnessShared),
}));

export const personalDocumentsInHarnessSharedRelations = relations(personalDocumentsInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [personalDocumentsInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const potMembersInHarnessSharedRelations = relations(potMembersInHarnessShared, ({one}) => ({
	potsInHarnessShared: one(potsInHarnessShared, {
		fields: [potMembersInHarnessShared.workspaceId, potMembersInHarnessShared.potHomeSlug],
		references: [potsInHarnessShared.workspaceId, potsInHarnessShared.canonicalPotHomeSlug]
	}),
}));

export const potsInHarnessSharedRelations = relations(potsInHarnessShared, ({many}) => ({
	potMembersInHarnessShareds: many(potMembersInHarnessShared),
}));

export const personalVaultImportJobsInHarnessSharedRelations = relations(personalVaultImportJobsInHarnessShared, ({one}) => ({
	usersInHarnessShared: one(usersInHarnessShared, {
		fields: [personalVaultImportJobsInHarnessShared.userId],
		references: [usersInHarnessShared.id]
	}),
}));

export const workspaceHostConnectionsInHarnessSharedRelations = relations(workspaceHostConnectionsInHarnessShared, ({many}) => ({
	workspaceHostsInHarnessShareds: many(workspaceHostsInHarnessShared),
}));