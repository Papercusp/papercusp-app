"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { readHostedBrowserApiMarker } from "../hosted-browser-api";
import { CLOUD_TUTORIAL_ID, CLOUD_TUTORIAL_VERSION, createTutorialState, sameTutorialScope, tutorialProgress, tutorialReducer, type SavedTutorialProgress, type TutorialEvent, type TutorialState, type TutorialVersion } from "@papercusp/operator-core/lib/onboarding/cloud-tutorial-lesson";

const endpoint = "/api/hosted/browser/onboarding/tutorial-progress";
interface ProgressRecord { revision: number; progress: SavedTutorialProgress }
function readRecord(value: unknown, version: TutorialVersion): ProgressRecord {
  const record = (value as { record?: ProgressRecord } | null)?.record;
  const progress = record?.progress;
  if (!record || !Number.isSafeInteger(record.revision) || record.revision < 0 || !progress ||
    progress.lessonId !== CLOUD_TUTORIAL_ID || progress.version !== version ||
    !["active", "paused", "skipped", "closed"].includes(progress.disposition) ||
    ![progress.scope?.tenantId, progress.scope?.userId, progress.scope?.workspaceId].every(id => typeof id === "string" && id.length > 0) ||
    [progress.inspectedResult, progress.inspectedRevision, progress.inspectedPractice].some(receipt => receipt && ![receipt.sessionId, receipt.taskId, receipt.resultId].every(id => typeof id === "string" && id.length > 0))) throw new Error("Invalid saved lesson progress. Check again to reload it.");
  return record;
}
const fingerprint = (progress: SavedTutorialProgress) => JSON.stringify([
  progress.scope.tenantId, progress.scope.userId, progress.scope.workspaceId,
  progress.lessonId, progress.version, progress.disposition,
  progress.inspectedResult?.sessionId ?? null, progress.inspectedResult?.taskId ?? null, progress.inspectedResult?.resultId ?? null,
  progress.inspectedRevision ?? null, progress.inspectedPractice ?? null,
]);

/** Extend the hosted progress seam. Server-returned scope is a consistency
 * token; cookies and server authorization remain the only source of authority.
 * Writes serialize per mount, coalesce UI changes, and never persist domain steps. */
export function useCloudTutorialProgress(selectionKey: string, version: TutorialVersion = CLOUD_TUTORIAL_VERSION) {
  const [state, setState] = useState<TutorialState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const recordRef = useRef<ProgressRecord | null>(null);
  const savedRef = useRef("");
  const pendingRef = useRef<{ progress: SavedTutorialProgress; mutationId: string } | null>(null);
  const writingRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  const dispatch = useCallback((event: TutorialEvent) => setState(current => current ? tutorialReducer(current, event) : current), []);
  const restore = useCallback((record: ProgressRecord) => {
    recordRef.current = record;
    savedRef.current = fingerprint(record.progress);
    setState(current => current && current.version === version && sameTutorialScope(current.scope, record.progress.scope)
      ? { ...current, disposition: record.progress.disposition, inspectedResult: record.progress.inspectedResult, inspectedRevision: record.progress.inspectedRevision, inspectedPractice: record.progress.inspectedPractice }
      : createTutorialState(record.progress.scope, record.progress, version));
  }, [version]);
  const request = useCallback((method: "GET" | "POST", signal: AbortSignal, body?: unknown) => {
    const marker = readHostedBrowserApiMarker();
    if (!marker) throw new Error("Sign in to the hosted app to save your lesson.");
    return fetch(version === 2 ? `${endpoint}?version=2` : endpoint, { method, signal, credentials: "same-origin", cache: "no-store",
      headers: { accept: "application/json", "x-papercusp-workspace": marker.controlPlaneWorkspaceId, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
  }, [version]);

  const reload = useCallback(async () => {
    const generation = ++generationRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController(); controllerRef.current = controller;
    pendingRef.current = null; writingRef.current = false;
    recordRef.current = null; savedRef.current = "";
    setState(null); setLoading(true); setNotice(null);
    try {
      const response = await request("GET", controller.signal);
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "Sign in and select an authorized workspace, then check again." : "Saved lesson progress is unavailable. Check again to reload it.");
      const record = readRecord(await response.json(), version);
      if (generation !== generationRef.current || controller.signal.aborted) return;
      restore(record);
    } catch (error) {
      if (generation === generationRef.current && !controller.signal.aborted) setNotice(error instanceof Error ? error.message : "Saved lesson progress is unavailable.");
    } finally {
      if (generation === generationRef.current && !controller.signal.aborted) setLoading(false);
    }
  }, [request, restore, version]);

  const flush = useCallback(async () => {
    const record = recordRef.current;
    const controller = controllerRef.current;
    if (writingRef.current || !record || !controller || controller.signal.aborted) return;
    const generation = generationRef.current;
    writingRef.current = true;
    try {
      while (pendingRef.current && generation === generationRef.current && !controller.signal.aborted) {
        const pending = pendingRef.current;
        const current = recordRef.current!;
        const response = await request("POST", controller.signal, {
          expectedScope: current.progress.scope, expectedRevision: current.revision, mutationId: pending.mutationId,
          disposition: pending.progress.disposition, ...(pending.progress.inspectedResult ? { inspectedResult: pending.progress.inspectedResult } : {}),
          ...(version === 2 ? { version, inspectedRevision: pending.progress.inspectedRevision, inspectedPractice: pending.progress.inspectedPractice } : {}),
        });
        if (generation !== generationRef.current || controller.signal.aborted) return;
        if (response.status === 401 || response.status === 403) {
          pendingRef.current = null; recordRef.current = null; setState(null);
          throw new Error("Your session or workspace changed. Sign in or select your workspace, then check again.");
        }
        if (!response.ok && response.status !== 409) throw new Error("Lesson progress could not be saved. Your Cloud controls still work; check again to retry saving.");
        const next = readRecord(await response.json(), version);
        if (generation !== generationRef.current || controller.signal.aborted) return;
        if (!sameTutorialScope(current.progress.scope, next.progress.scope)) {
          pendingRef.current = null; recordRef.current = null; setState(null);
          throw new Error("Your workspace changed. Check again to load its lesson.");
        }
        if (response.status === 409) {
          pendingRef.current = null; restore(next);
          setNotice("Your guide changed in another tab. Its latest saved progress has been restored.");
          return;
        }
        recordRef.current = next; savedRef.current = fingerprint(next.progress);
        if (pendingRef.current === pending) pendingRef.current = null;
        setNotice(null);
      }
    } catch (error) {
      if (generation === generationRef.current && !controller.signal.aborted) setNotice(error instanceof Error ? error.message : "Lesson progress could not be saved.");
    } finally {
      if (generation === generationRef.current) writingRef.current = false;
    }
  }, [request, restore, version]);

  useEffect(() => {
    void reload();
    // A hosted shell may change the authenticated selection without remounting
    // the Cloud surface. Invalidate every response and speech/guide scope first.
    const changed = () => { void reload(); };
    window.addEventListener("workspacechange", changed);
    window.addEventListener("papercusp:session-changed", changed);
    return () => {
      ++generationRef.current; controllerRef.current?.abort(); pendingRef.current = null;
      window.removeEventListener("workspacechange", changed);
      window.removeEventListener("papercusp:session-changed", changed);
    };
  }, [selectionKey, reload]);
  useEffect(() => {
    if (!state || !recordRef.current) return;
    const progress = tutorialProgress(state);
    if (pendingRef.current && fingerprint(progress) === fingerprint(pendingRef.current.progress)) return;
    if (!writingRef.current && !pendingRef.current && fingerprint(progress) === savedRef.current) return;
    pendingRef.current = { progress, mutationId: crypto.randomUUID() };
    void flush();
  }, [state, flush]);
  const retry = useCallback(() => pendingRef.current && recordRef.current ? void flush() : void reload(), [flush, reload]);
  return { state, dispatch, loading, notice, retry };
}
