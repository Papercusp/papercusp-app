"use client";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/app/harness/Button";
import type { TutorialStepId, TutorialVersion } from "@papercusp/operator-core/lib/onboarding/cloud-tutorial-lesson";
import type { WorkspaceHostConnectionRow, WorkspaceHostControlRow } from "@/app/cloud-workspaces/workspace-view-model";
import type { TutorialSessionObservation } from "./cloud-tutorial-session";
import { CloudTutorialGuide } from "./cloud-tutorial-guide";
import { useCloudTutorialProgress } from "./use-cloud-tutorial-progress";
const CloudTutorialSession = lazy(async () => ({ default: (await import("./cloud-tutorial-session")).CloudTutorialSession }));
const CloudTutorialAssistance = lazy(async () => ({ default: (await import("./cloud-tutorial-assistance")).CloudTutorialAssistance }));

/** The authenticated workspace query owns eligibility. This entry only selects
 * an existing row; it never provisions, launches, repairs or changes access. */
export function CloudTutorialPreparedEntry({ workspaces, loading, error, onSelect, onAdvanced }: {
  workspaces: readonly WorkspaceHostControlRow[]; loading: boolean; error: Error | null;
  onSelect: (id: string) => void; onAdvanced: () => void;
}) {
  const prepared = workspaces.filter(row => row.desiredState === "running" && row.observedState === "running" && row.health?.status === "healthy");
  return <section aria-label="Beginner workspace entry" data-tutorial-target="cloud-prepared-workspace" tabIndex={-1}
    style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 20, marginBottom: 16 }}>
    <h2>Do useful work with your first agent</h2>
    <p>Start with a prepared workspace. You do not need cloud credentials or machine settings for this path.</p>
    <p>Recommended: keep the session launcher's existing model and account defaults and use interactive mode. Review model usage costs before you launch.</p>
    {loading ? <p role="status">Checking your authorized workspaces…</p> : error ?
      <p role="alert">Your workspace list could not be read. Sign in or ask your administrator to check access, then check again.</p> : prepared.length ?
      <ul>{prepared.map(row => <li key={row.id}>
        <strong>{row.name}</strong>
        <p>{typeof row.estimatedMonthlyUsd === "number" && Number.isFinite(row.estimatedMonthlyUsd) && row.estimatedMonthlyUsd >= 0
          ? `Estimated workspace cost: $${row.estimatedMonthlyUsd.toFixed(2)} per month. Provider billing is authoritative.`
          : "A workspace cost estimate is unavailable. Ask your administrator about provider charges before using it."}</p>
        <Button aria-label={`Use prepared workspace ${row.name}`} onClick={() => onSelect(row.id)}>Use this prepared workspace</Button>
      </li>)}</ul> :
      <p role="status">No prepared healthy workspace is available to your account. Ask your administrator to prepare one and grant you access. Choosing this guide does not create or repair a billable machine.</p>}
    <p>Cloud resources can continue to incur charges while you use or pause this guide.</p>
    <Button variant="ghost" onClick={onAdvanced}>Advanced: connect my own cloud</Button>
  </section>;
}

export function CloudTutorialCompanion({ selectionKey, version = 1, connection, workspace, boundWorkspaceId, configurationValid, configurationReviewed, controlLoading, controlError, onCheckAgain, onShowStep }: {
  version?: TutorialVersion;
  selectionKey: string; connection: WorkspaceHostConnectionRow | null;
  workspace: WorkspaceHostControlRow | null; boundWorkspaceId: string | null;
  configurationValid: boolean; configurationReviewed: boolean;
  controlLoading: boolean; controlError: Error | null;
  onCheckAgain: () => void; onShowStep: (step: TutorialStepId) => void;
}) {
  const { state, dispatch, loading, notice, retry } = useCloudTutorialProgress(selectionKey, version);
  const revision = useRef(0);
  const [session, setSession] = useState<{ selectionKey: string; value: TutorialSessionObservation } | null>(null);
  const onSessionObservation = useCallback((value: TutorialSessionObservation) => setSession({ selectionKey, value }), [selectionKey]);
  const workspaceReady = Boolean(state && workspace?.observedState === "running" && workspace.desiredState === "running" && workspace.health?.status === "healthy" && boundWorkspaceId === state.scope.workspaceId);
  useEffect(() => {
    if (!state || controlLoading) return;
    dispatch({ type: "observe", observation: { scope: state.scope, revision: ++revision.current,
      access: controlError ? "denied" : "allowed",
      ...(connection?.target === "gcp" ? { connection: { id: connection.id, provider: "gcp", validated: connection.status === "connected" } } : {}),
      ...(workspace || connection ? { configuration: { connectionId: workspace?.connectionId ?? connection!.id, valid: configurationValid, costReviewed: configurationReviewed } } : {}),
      ...(workspace && state ? { workspace: { id: state.scope.workspaceId, connectionId: workspace.connectionId, healthy: workspaceReady } } : {}),
      ...(session?.selectionKey === selectionKey && workspaceReady ? session.value : {}),
      ...(workspace && !workspaceReady ? { attempt: { step: "workspace", status: workspace.operation?.status === "failed" ? "failed" : "pending" } } : {}),
    } });
  }, [state?.scope, connection, workspace, workspaceReady, configurationValid, configurationReviewed, session, selectionKey, controlLoading, controlError, dispatch]);
  return <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    {notice && <p role="status">{notice}</p>}
    {!state ? <><p role="status">{loading ? "Preparing your lesson…" : "Your Cloud controls remain available while lesson progress is unavailable."}</p>
      {!loading && <Button onClick={retry}>Check lesson again</Button>}</> :
      <CloudTutorialGuide state={state} dispatch={dispatch} onShowStep={onShowStep}
        assistance={(step, status) => <Suspense fallback={<p>Preparing lesson help. You can continue with the instructions.</p>}><CloudTutorialAssistance
          key={`${state.scope.tenantId}:${state.scope.userId}:${state.scope.workspaceId}:${version}:${step.id}`} scope={state.scope} version={version} step={step} status={status} onShowStep={() => onShowStep(step.id)} /></Suspense>}
        onCheckAgain={() => { onCheckAgain(); if (notice) retry(); }} />}
    {state && workspaceReady && configurationValid && configurationReviewed && !controlError && <Suspense fallback={<p role="status">Preparing your workspace session controls…</p>}><CloudTutorialSession
      key={`${selectionKey}:${version}:${state.scope.tenantId}:${state.scope.userId}:${state.scope.workspaceId}`} scope={state.scope} version={version}
      onObservation={onSessionObservation} onInspect={(task, kind) => dispatch({ type: "inspect-result", kind, scope: state.scope, sessionId: task.sessionId, taskId: task.id, resultId: task.resultId! })} /></Suspense>}
  </div>;
}
