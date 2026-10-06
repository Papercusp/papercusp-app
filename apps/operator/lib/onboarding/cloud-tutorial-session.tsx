"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/app/harness/Button";
import NewSessionLauncher from "@/app/adv/sessions/NewSessionLauncher";
import { useAgentThinkingStream, groupEntriesIntoTurns, type TimelineEntry } from "@/app/harness/AgentThinkingStream";
import { OperatorChat } from "@/app/_components/OperatorChat";
import { sessionTimelineToChatMessages } from "@/app/_components/chat/session-transcript-mapping";
import { sendToSessionOwner, useOwnerSessionChat } from "@/app/_components/chat/use-owner-session-chat";
import { CLOUD_TUTORIAL_TASK, CLOUD_TUTORIAL_PLAN_TASK, CLOUD_TUTORIAL_REVISION_TASK, type ProductObservation, type TutorialScope, type TutorialVersion, type TutorialTaskObservation } from "@papercusp/operator-core/lib/onboarding/cloud-tutorial-lesson";

type RequestReceipt = { id: string; prompt: string; sentAt: number };
export type TutorialSessionObservation = Pick<ProductObservation, "agent" | "task" | "revisionTask" | "practiceTask" | "attempt">;
type TaskKind = "first" | "revision" | "practice";

/** Match a human-submitted request in THIS owner's transcript. Commentary,
 * another request's answer, and legacy results without an outcome never certify success. */
export function correlatedTutorialTask(entries: readonly TimelineEntry[], request: RequestReceipt | null) {
  if (!request) return null;
  const turn = groupEntriesIntoTurns(entries).find(candidate => candidate.prompt?.text?.includes(request.prompt));
  const terminal = turn?.entries.filter(entry => entry.kind === "result" && entry.outcome).at(-1);
  const hasAnswer = turn?.entries.some(entry => (entry.kind === "text" || entry.kind === "result") && entry.text?.trim());
  return { entries: turn ? [turn.prompt!, ...turn.entries] : [],
    status: terminal?.outcome === "failed" ? "failed" as const : terminal?.outcome === "succeeded" && terminal.ts && hasAnswer ? "succeeded" as const : "pending" as const,
    resultId: terminal?.outcome === "succeeded" && terminal.ts && hasAnswer ? `${request.id}:${terminal.ts}` : undefined };
}

/** Real product controls, separate from Guide actions. Reuses the maintained
 * launcher, owner resolver, message transport, stream parser and chat renderer. */
export function CloudTutorialSession({ scope, version = 1, onObservation, onInspect }: {
  version?: TutorialVersion;
  scope: TutorialScope; onObservation: (value: TutorialSessionObservation) => void;
  onInspect: (task: NonNullable<ProductObservation["task"]>, kind?: TaskKind) => void;
}) {
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [resolution, setResolution] = useState(0);
  return <section aria-label="First agent workspace session">
    <div data-tutorial-target="cloud-agent" tabIndex={-1}>
      <h3>Run an agent on this workspace</h3>
      <p>Choose an available model and account. Model usage may incur costs. Review your provider account before launching.</p>
      <NewSessionLauncher initialPosture="interactive" onLaunched={id => { setOwnerId(id); setResolution(value => value + 1); }} />
      {ownerId ? <p role="status">Waiting for your launched session to become available.</p> : <p>The lesson waits for the session you explicitly launch here.</p>}
    </div>
    {ownerId && <SessionConversation key={`${ownerId}:${resolution}`} ownerId={ownerId} scope={scope} version={version}
      onObservation={onObservation} onInspect={onInspect} onRetry={() => setResolution(value => value + 1)} />}
  </section>;
}

function SessionConversation({ ownerId, scope, version, onObservation, onInspect, onRetry }: {
  version: TutorialVersion;
  ownerId: string; scope: TutorialScope; onObservation: (value: TutorialSessionObservation) => void;
  onInspect: (task: NonNullable<ProductObservation["task"]>, kind?: TaskKind) => void; onRetry: () => void;
}) {
  const chat = useOwnerSessionChat(ownerId);
  return <>
    {chat.resolveError && <p role="alert">Your session could not be read. Check your account and workspace access, then check again.</p>}
    {!chat.streamUrl && <><p role="status">{chat.resolving ? "Checking your session…" : "The session has not appeared yet. Check its launch receipt and try again."}</p><Button onClick={onRetry}>Check session again</Button></>}
    {chat.streamUrl && chat.resolved?.active !== false && (version === 2
      ? <BeginnerSessionTask streamUrl={chat.streamUrl} ownerId={ownerId} scope={scope} onObservation={onObservation} onInspect={onInspect} />
      : <SessionTask streamUrl={chat.streamUrl} ownerId={ownerId} scope={scope} onObservation={onObservation} onInspect={onInspect} />)}
    {chat.resolved?.active === false && <p role="alert">This session ended. Launch a new session to continue.</p>}
  </>;
}

/** Extends the same owner-resolved transcript and send transport. Each phase
 * has its own request/result receipt; guide controls never send product work. */
function BeginnerSessionTask({ streamUrl, ownerId, scope, onObservation, onInspect }: {
  streamUrl: string; ownerId: string; scope: TutorialScope;
  onObservation: (value: TutorialSessionObservation) => void;
  onInspect: (task: TutorialTaskObservation, kind?: TaskKind) => void;
}) {
  const stream = useAgentThinkingStream("", "", "", streamUrl);
  const [requests, setRequests] = useState<Partial<Record<TaskKind, RequestReceipt & { firstTaskId?: string }>>>({});
  const [reviewed, setReviewed] = useState<Partial<Record<TaskKind, string>>>({});
  const [draft, setDraft] = useState("");
  const [activeKind, setActiveKind] = useState<TaskKind>("first");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [delayed, setDelayed] = useState(false);
  const busy = useRef(false), generation = useRef(0);
  useEffect(() => () => { ++generation.current; }, []);
  const results = useMemo(() => Object.fromEntries((["first", "revision", "practice"] as const).map(kind => {
    const request = requests[kind];
    const correlation = correlatedTutorialTask(stream.events, request ?? null);
    const task: TutorialTaskObservation | undefined = request ? { id: request.id, sessionId: ownerId, sampleTask: kind !== "practice", submittedByUser: true,
      status: correlation?.status ?? "pending", resultId: correlation?.resultId, firstTaskId: request.firstTaskId } : undefined;
    return [kind, { correlation, task }];
  })) as Record<TaskKind, { correlation: ReturnType<typeof correlatedTutorialTask>; task?: TutorialTaskObservation }>, [requests, stream.events, ownerId]);
  useEffect(() => {
    onObservation({ agent: { id: ownerId, workspaceId: scope.workspaceId, launchedByUser: true, available: stream.status === "live" || stream.status === "done" },
      task: results.first.task, revisionTask: results.revision.task, practiceTask: results.practice.task,
      ...(error || delayed || stream.status === "error" ? { attempt: { step: activeKind === "first" ? "task" : activeKind, status: delayed && !error && stream.status !== "error" ? "delayed" : "failed" } } : {}) });
  }, [ownerId, scope.workspaceId, results, stream.status, error, delayed, activeKind, onObservation]);
  useEffect(() => {
    setDelayed(false);
    if (!requests[activeKind] || results[activeKind].task?.status !== "pending") return;
    const timer = setTimeout(() => setDelayed(true), 45_000);
    return () => clearTimeout(timer);
  }, [requests, activeKind, results]);
  const firstReviewed = Boolean(requests.first && reviewed.first === requests.first.id);
  const revisionReviewed = firstReviewed && Boolean(requests.revision && reviewed.revision === requests.revision.id);
  const independentDraft = draft.trim().length > 0 && ![CLOUD_TUTORIAL_TASK, CLOUD_TUTORIAL_PLAN_TASK, CLOUD_TUTORIAL_REVISION_TASK].includes(draft.trim());
  const pending = results[activeKind].task?.status === "pending";
  const blocked = sending || stream.status === "connecting" || stream.status === "error" || (pending && !error && !delayed);
  const submit = async (kind: TaskKind) => {
    if (busy.current || blocked || (kind === "revision" && !firstReviewed) || (kind === "practice" && (!revisionReviewed || !independentDraft))) return;
    busy.current = true; setSending(true); setError(null); setActiveKind(kind);
    const epoch = generation.current;
    const id = crypto.randomUUID();
    const taskText = kind === "first" ? CLOUD_TUTORIAL_PLAN_TASK : kind === "revision" ? CLOUD_TUTORIAL_REVISION_TASK
      : `Answer this different task using only the text I supply. If information is missing, say so. Do not use tools, access files, contact anyone, or change anything.\n\n${draft.trim()}\n\nThis is a read-only proposal exercise; external actions are not approved.`;
    const request = { id, prompt: `${taskText}\n\nLesson request: ${id}`, sentAt: Date.now(), ...(kind !== "first" ? { firstTaskId: requests.first!.id } : {}) };
    setRequests(current => kind === "first" ? { first: request } : kind === "revision" ? { first: current.first, revision: request } : { ...current, practice: request });
    setReviewed(current => kind === "first" ? {} : kind === "revision" ? { first: current.first } : { first: current.first, revision: current.revision });
    try { await sendToSessionOwner(ownerId, request.prompt); }
    catch { if (epoch === generation.current) setError("Delivery could not be confirmed. Inspect this session before explicitly retrying; your message may still finish."); }
    finally { if (epoch === generation.current) { busy.current = false; setSending(false); } }
  };
  const review = (kind: TaskKind) => {
    const task = results[kind].task;
    if (task?.status !== "succeeded" || !task.resultId || (kind === "revision" && !firstReviewed) || (kind === "practice" && !revisionReviewed)) return;
    setReviewed(current => ({ ...current, [kind]: task.id })); onInspect(task, kind);
  };
  const answer = (kind: TaskKind) => <>
    <div style={{ height: 300, minHeight: 240 }}><OperatorChat messages={sessionTimelineToChatMessages(results[kind].correlation?.entries ?? [])}
      busy={results[kind].task?.status === "pending"} passive onSend={() => {}} composerDisabled composerDisabledMessage="Use the lesson task control to send a request."
      showQuickDraftPrompts={false} agentName="Your workspace agent" emptyStateBody="The answer to this request will appear here." /></div>
    <Button disabled={results[kind].task?.status !== "succeeded" || !results[kind].task?.resultId} onClick={() => review(kind)}>
      {kind === "first" ? "I've reviewed the action plan" : kind === "revision" ? "I've reviewed the revision" : "I've reviewed my own task's answer"}
    </Button>
  </>;
  return <>
    <div data-tutorial-target="cloud-task" tabIndex={-1}>
      <h3>Turn meeting notes into an action plan</h3>
      <p>Describe the goal, provide context and say what output you need. Ask for a proposal before consequential actions. Approve those actions explicitly only after reviewing the plan; a suggested action is not your approval.</p>
      <p>Check answers against your source, ask for corrections and verify the corrected result. This exercise uses supplied text without tools or external actions.</p>
      <p>Pausing or closing this guide only pauses its instructions. To stop an agent, use its session stop control in Sessions. To stop compute, use the workspace Stop control and check its status; retained disks can still cost money. Model usage is billed separately.</p>
      <p style={{ whiteSpace: "pre-wrap" }}>{CLOUD_TUTORIAL_PLAN_TASK}</p>
      <Button disabled={blocked} onClick={() => void submit("first")}>{requests.first ? "Send action-plan task again" : "Send action-plan task"}</Button>
    </div>
    {error && <p role="alert">{error}</p>}
    {delayed && <p role="status">This request is taking longer than expected. Inspect its transcript and account status before retrying.</p>}
    {results[activeKind].task?.status === "failed" && <p role="alert">This request failed. Review its transcript before explicitly sending it again.</p>}
    <div data-tutorial-target="cloud-result" tabIndex={-1}><h3>Review the action plan against the notes</h3>{answer("first")}</div>
    {firstReviewed && <div data-tutorial-target="cloud-revision" tabIndex={-1}>
      <h3>Ask for a revision</h3><p>{CLOUD_TUTORIAL_REVISION_TASK}</p>
      <Button disabled={blocked} onClick={() => void submit("revision")}>Send revision request</Button>{answer("revision")}
    </div>}
    {revisionReviewed && <div data-tutorial-target="cloud-practice" tabIndex={-1}>
      <h3>Write a different read-only task yourself</h3><p>Include your goal, source text and requested output. Choose a different task that needs no tools or external actions. Keep private information out of this exercise.</p>
      <label htmlFor="cloud-practice-draft">Your different task</label>
      <textarea id="cloud-practice-draft" value={draft} maxLength={4000} onChange={event => setDraft(event.target.value)} rows={6} />
      <Button disabled={blocked || !independentDraft} onClick={() => void submit("practice")}>Send my own task</Button>
      {!independentDraft && <p>Write your own different task before sending; an empty draft or lesson sample does not count.</p>}
      {answer("practice")}
    </div>}
  </>;
}

function SessionTask({ streamUrl, ownerId, scope, onObservation, onInspect }: {
  streamUrl: string; ownerId: string; scope: TutorialScope;
  onObservation: (value: TutorialSessionObservation) => void; onInspect: (task: NonNullable<ProductObservation["task"]>) => void;
}) {
  const stream = useAgentThinkingStream("", "", "", streamUrl);
  const [request, setRequest] = useState<RequestReceipt | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [delayed, setDelayed] = useState(false);
  const generation = useRef(0);
  const busy = useRef(false);
  useEffect(() => () => { ++generation.current; }, []);
  const correlation = useMemo(() => correlatedTutorialTask(stream.events, request), [stream.events, request]);
  const task = useMemo<NonNullable<ProductObservation["task"]> | undefined>(() => request ? {
    id: request.id, sessionId: ownerId, sampleTask: true, submittedByUser: true,
    status: correlation?.status ?? "pending", ...(correlation?.resultId ? { resultId: correlation.resultId } : {}),
  } : undefined, [request, ownerId, correlation]);
  useEffect(() => {
    onObservation({ agent: { id: ownerId, workspaceId: scope.workspaceId, launchedByUser: true, available: stream.status === "live" || stream.status === "done" },
      ...(task ? { task } : {}),
      ...(error || delayed || stream.status === "error" ? { attempt: { step: task ? "task" as const : "agent" as const, status: error || stream.status === "error" ? "failed" as const : "delayed" as const } } : {}) });
  }, [ownerId, scope.workspaceId, stream.status, task, error, delayed, onObservation]);
  useEffect(() => {
    setDelayed(false);
    if (!request || task?.status !== "pending") return;
    const timer = setTimeout(() => setDelayed(true), 45_000);
    return () => clearTimeout(timer);
  }, [request, task?.status]);
  const submit = useCallback(async () => {
    if (busy.current) return;
    busy.current = true; setSending(true); setError(null);
    const epoch = generation.current;
    const id = crypto.randomUUID();
    const receipt = { id, prompt: `${CLOUD_TUTORIAL_TASK}\n\nLesson request: ${id}`, sentAt: Date.now() };
    setRequest(receipt);
    try { await sendToSessionOwner(ownerId, receipt.prompt); }
    catch { if (epoch === generation.current) setError("Delivery could not be confirmed. Check this session's transcript before explicitly retrying; an accepted message may still finish."); }
    finally { if (epoch === generation.current) { busy.current = false; setSending(false); } }
  }, [ownerId]);
  return <>
    <div data-tutorial-target="cloud-task" tabIndex={-1}>
      <h3>Send a small read-only task</h3><p>{CLOUD_TUTORIAL_TASK}</p>
      <Button disabled={sending || stream.status === "connecting" || (task?.status === "pending" && !error && !delayed)} onClick={() => void submit()}>
        {request ? "Send sample task again" : "Send sample task"}
      </Button>
      {error && <p role="alert">{error}</p>}
      {delayed && <p role="status">This task is taking longer than expected. Inspect its transcript and account status before retrying.</p>}
      {task?.status === "failed" && <p role="alert">The task did not finish successfully. Review the session's error, then explicitly send it again.</p>}
    </div>
    <div data-tutorial-target="cloud-result" tabIndex={-1}>
      <h3>Inspect your task's answer</h3>
      <div style={{ height: 360, minHeight: 240 }}><OperatorChat messages={sessionTimelineToChatMessages(correlation?.entries ?? [])} busy={task?.status === "pending"} passive
        onSend={() => {}} composerDisabled composerDisabledMessage="Use Send sample task above to submit the lesson task."
        showQuickDraftPrompts={false} agentName="Your workspace agent" emptyStateBody="The correlated answer will appear here after your sample task." /></div>
      <Button disabled={task?.status !== "succeeded" || !task.resultId} onClick={() => { if (task?.status === "succeeded" && task.resultId) onInspect(task); }}>I've inspected this answer</Button>
    </div>
  </>;
}
