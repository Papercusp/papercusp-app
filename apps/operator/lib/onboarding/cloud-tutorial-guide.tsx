"use client";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { useReducedMotion } from "motion/react";
import { Button } from "@/app/harness/Button";
import { LazyDetails } from "@/app/_components/LazyDetails";
import { CLOUD_TUTORIAL_STEPS, tutorialSteps, confirmedTutorialSteps, currentTutorialStep, tutorialStepStatus, type TutorialEvent, type TutorialState, type LessonStep, type StepStatus } from "@papercusp/operator-core/lib/onboarding/cloud-tutorial-lesson";
import { CloudTutorialHighlight } from "./cloud-tutorial-adapter";
import { createTutorialAnalytics } from "./cloud-tutorial-analytics";

const statusCopy = {
  loading: "Preparing your lesson…", ready: "Use the highlighted control in the app.",
  waiting: "Waiting for the action to finish. You can keep using the app.",
  delayed: "This action is taking longer than expected. Check its status in the app before retrying.",
  error: "This step needs attention. Follow the recovery shown by the app.",
  blocked: "Your session or workspace access needs attention. Sign in or request access to continue.",
  "missing-target": "The control is not visible yet. Open the indicated app view, then check again.",
  complete: "Your first agent lesson is complete.",
};
export function CloudTutorialHelpEntry({ onStart, summaryRef }: { onStart: () => void; summaryRef?: Ref<HTMLButtonElement> }) {
  return <LazyDetails summary="Help" summaryRef={summaryRef}><Button onClick={onStart}>Get your first agent running</Button></LazyDetails>;
}

/** A nonmodal companion to the real product. It never calls a provision,
 * launch, send-task or repair endpoint. Those actions stay with the user. */
export function CloudTutorialGuide({ state, dispatch, onCheckAgain, onShowStep, help, voice, assistance, reducedMotion: requestedReducedMotion }: {
  state: TutorialState; dispatch: (event: TutorialEvent) => void;
  onShowStep?: (step: (typeof CLOUD_TUTORIAL_STEPS)[number]["id"]) => void;
  onCheckAgain?: () => void; help?: ReactNode; voice?: ReactNode; reducedMotion?: boolean;
  assistance?: (step: LessonStep, status: StepStatus) => ReactNode;
}) {
  const prefersReducedMotion = useReducedMotion() ?? false;
  const reducedMotion = requestedReducedMotion === true || prefersReducedMotion;
  const [reviewIndex, setReviewIndex] = useState<number | null>(null);
  const [highlightStatus, setHighlightStatus] = useState<"waiting" | "missing" | "ready">("waiting");
  const pendingFocus = useRef<string | null>(null);
  const pendingControlFocus = useRef<"resume" | "show" | "restart" | "entry" | null>(null);
  const resumeControl = useRef<HTMLButtonElement | null>(null);
  const showControl = useRef<HTMLButtonElement | null>(null);
  const restartControl = useRef<HTMLButtonElement | null>(null);
  const entryControl = useRef<HTMLButtonElement | null>(null);
  const previousScope = useRef(state.scope);
  const trigger = useRef<HTMLElement | null>(null);
  const restoreEntryFocus = () => {
    const original = trigger.current;
    if (original?.isConnected && original !== document.body && original !== document.documentElement) {
      original.focus({ preventScroll: true });
      if (document.activeElement === original) return;
    }
    entryControl.current?.focus({ preventScroll: true });
  };
  const disposedScope = `${state.scope.tenantId}:${state.scope.userId}:${state.scope.workspaceId}`;
  useEffect(() => {
    trigger.current = document.activeElement as HTMLElement | null;
    return () => { if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true }); };
  }, [disposedScope]);
  useEffect(() => {
    if (previousScope.current !== state.scope) { pendingFocus.current = null; setHighlightStatus("waiting"); setReviewIndex(null); previousScope.current = state.scope; }
  }, [state.scope]);
  const domainStep = currentTutorialStep(state);
  const steps = tutorialSteps(state.version);
  const step = reviewIndex === null ? domainStep : steps[reviewIndex];
  const completed = confirmedTutorialSteps(state);
  const status = tutorialStepStatus(state);
  const displayStatus = reviewIndex !== null && highlightStatus === "missing" ? "missing-target" : status;
  const active = state.disposition === "active";
  useEffect(() => {
    const destination = pendingControlFocus.current;
    if (!destination) return;
    const control = destination === "resume" ? resumeControl.current : destination === "show" ? showControl.current ?? restartControl.current
      : destination === "restart" ? restartControl.current : entryControl.current;
    if (destination !== "entry" && !control?.isConnected) return;
    // Highlight cleanup can restore its previous product focus. Restore the
    // user's guide action after that cleanup, without stealing focus on load.
    const frame = requestAnimationFrame(() => {
      if (destination === "entry") restoreEntryFocus();
      else control?.focus({ preventScroll: true });
    });
    pendingControlFocus.current = null;
    return () => cancelAnimationFrame(frame);
  }, [state.disposition, reviewIndex]);
  const analytics = useRef<ReturnType<typeof createTutorialAnalytics> | null>(null);
  analytics.current ??= createTutorialAnalytics();
  useEffect(() => { analytics.current!.update(state, step?.id); }, [state, step?.id]);
  useEffect(() => {
    if (!active) { pendingFocus.current = null; return; }
    if (highlightStatus !== "ready" || pendingFocus.current !== step?.id) return;
    const target = document.querySelector<HTMLElement>(step.target);
    if (target) { target.scrollIntoView({ behavior: reducedMotion ? "instant" : "smooth", block: "center" }); target.focus({ preventScroll: true }); pendingFocus.current = null; }
  }, [active, highlightStatus, step, reducedMotion]);
  const replay = () => {
    const focused = document.activeElement as HTMLElement | null;
    if (focused && !focused.closest("[data-cloud-tutorial-guide]")) trigger.current = focused;
    analytics.current!.action('replay', steps[0].id); setReviewIndex(0); dispatch({ type: "action", action: "replay" });
  };
  const action = (name: "pause" | "resume" | "skip" | "exit") => {
    pendingControlFocus.current = name === "pause" ? "resume" : name === "resume" ? "show" : name === "skip" ? "restart" : "entry";
    dispatch({ type: "action", action: name });
    if (name === "exit") restoreEntryFocus();
  };
  if (state.disposition === "closed") return <CloudTutorialHelpEntry onStart={replay} summaryRef={entryControl} />;
  return <>
    <CloudTutorialHelpEntry onStart={replay} summaryRef={entryControl} />
    <aside role="region" aria-label="First agent guide" data-cloud-tutorial-guide
      style={{ border: "1px solid var(--border)", background: "var(--bg-1)", borderRadius: 8, padding: 20, display: "flex", flexDirection: "column", gap: 12, width: "min(100%, 360px)", alignSelf: "start" }}>
      <h2 id="cloud-tutorial-title">{state.version === 2 ? "Do useful work with your first agent" : "Get your first agent running"}</h2>
      <p>{completed.length} of {steps.length} steps confirmed</p>
      {active && step && <>
        <h3>{step.title}</h3><p>{step.brief}</p><p>{step.details}</p>
        {completed.includes(step.id) && <p>Already completed in this workspace.</p>}
      </>}
      <p role={displayStatus === "error" || displayStatus === "blocked" ? "alert" : "status"} aria-live="polite">
        {state.disposition === "paused" ? "Your lesson is paused." : state.disposition === "skipped" ? "You can start this lesson again from Help." : statusCopy[displayStatus]}
      </p>
      {active && step && (displayStatus === "error" || displayStatus === "delayed" || displayStatus === "missing-target") && <p>{step.recovery}</p>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {active && step && <Button ref={showControl} onClick={() => {
          pendingFocus.current = step.id;
          onShowStep?.(step.id);
          const target = document.querySelector<HTMLElement>(step.target);
          if (target) { target.scrollIntoView({ behavior: reducedMotion ? "instant" : "smooth", block: "center" }); target.focus({ preventScroll: true }); pendingFocus.current = null; }
          else { setHighlightStatus("missing"); dispatch({ type: "target", scope: state.scope, step: step.id, status: "missing" }); }
        }}>Show me</Button>}
        {active && status !== "complete" && <Button onClick={() => { analytics.current!.action('check_again', step?.id); dispatch({ type: "action", action: "check-again" }); onCheckAgain?.(); }}>Check again</Button>}
        {active && <Button onClick={() => action("pause")}>Pause</Button>}
        {state.disposition === "paused" && <Button ref={resumeControl} onClick={() => action("resume")}>Resume guide</Button>}
        {state.disposition !== "skipped" && <Button onClick={() => action("skip")}>Skip lesson</Button>}
        <Button ref={restartControl} onClick={replay}>{status === "complete" ? "Replay lesson" : "Restart lesson"}</Button>
        {reviewIndex !== null && active && <Button onClick={() => setReviewIndex(reviewIndex < steps.length - 1 ? reviewIndex + 1 : null)}>Next explanation</Button>}
        <Button onClick={() => action("exit")}>Close guide</Button>
      </div>
      {active && displayStatus !== 'blocked' && <>{voice}{step && assistance ? assistance(step, displayStatus) : help ?? <p>Contextual help is unavailable. You can continue using the instructions above.</p>}</>}
    </aside>
    {active && step && <CloudTutorialHighlight target={step.target} active contextKey={`${disposedScope}:${step.id}`} reducedMotion={reducedMotion}
      onStatus={targetStatus => { setHighlightStatus(targetStatus); if (step.id === domainStep?.id) dispatch({ type: "target", scope: state.scope, step: step.id, status: targetStatus }); }} />}
  </>;
}
