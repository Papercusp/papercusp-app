"use client";

/**
 * WorkItemDiscussion — the reusable inline Papercup host for one durable
 * work-item conversation (owner-inbox-single-pane P-018 / D-014).
 *
 * This deliberately reuses the full operator conversation stack. The only new
 * responsibility here is resolving the work-item → conversation identity:
 * read the focused sync projection first, then cross the explicit idempotent
 * POST mutation boundary when no cached binding exists. Once an id resolves,
 * a nested OperatorConversationProvider owns the scoped runtime and
 * OperatorChat supplies the same transcript, cards, reports, tools, choices,
 * cancel/skip controls, history paging, and composer as the global pane.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { MessageCircle, RefreshCw, X } from "lucide-react";
import { useSyncQuery } from "@papercusp/sync";
import { useWorkspaceId } from "@/lib/use-workspace-id";
import {
  OperatorConversationProvider,
  useOperatorConversation,
} from "../OperatorConversationProvider";
import { OperatorChat } from "../OperatorChat";
import "./work-item-discussion.css";

/** URL state shared by InboxPane and WorkItemDetail. The value uses the
 * existing encodeScopedRef/decodeScopedRef grammar: `<harness>::<work-item>`. */
export const WORK_ITEM_DISCUSSION_PARAM = "opcid";

type ConversationIdentity = { id: string };
type LocalResolution = {
  key: string;
  id: string | null;
  error: string | null;
};

export interface WorkItemDiscussionProps {
  harnessSlug: string;
  workItemId: string;
  title?: string | null;
  onClose?: () => void;
  /** Focus this discussion once every inert ancestor has been released. The
   * Inbox report can mount it underneath an active takeover before closing. */
  focusWhenInteractive?: boolean;
}

function WorkItemConversationChat({
  harnessSlug,
  workItemId,
  title,
  conversationId,
}: {
  harnessSlug: string;
  workItemId: string;
  title?: string | null;
  conversationId: string;
}) {
  const conv = useOperatorConversation();
  const workspaceId = useWorkspaceId();
  const starter = useMemo(
    () => buildWorkItemDiscussionMessage(workItemId, title),
    [title, workItemId],
  );
  const startedConversationRef = useRef<string | null>(null);

  // Discuss is an ACTION, not just a navigation. Wait until the durable
  // history has loaded before deciding the thread is empty, then send one
  // contextual opening turn. Existing/reloaded conversations never receive a
  // duplicate because their persisted history is non-empty; the ref closes
  // repeated-effect/rerender races within the current mount.
  useEffect(() => {
    if (
      !conv.historyHydrated ||
      conv.messages.length > 0 ||
      conv.busy ||
      conv.error ||
      startedConversationRef.current === conversationId
    ) {
      return;
    }
    startedConversationRef.current = conversationId;
    conv.sendUserMessage(starter);
  }, [
    conv.busy,
    conv.error,
    conv.historyHydrated,
    conv.messages.length,
    conv.sendUserMessage,
    conversationId,
    starter,
  ]);

  return (
    <div
      className="wi-discussion__chat"
      data-testid="work-item-discussion-chat"
    >
      <OperatorChat
        messages={conv.messages}
        busy={conv.busy}
        peerBusy={conv.peerBusy}
        passive={conv.mode === "passive"}
        onSend={conv.sendUserMessage}
        onGenerateIdeas={conv.generateIdeas}
        banner={
          <div
            className="wi-discussion__context"
            data-testid="work-item-discussion-context"
          >
            <span>{workItemId}</span>
            {conv.bannerText ? <span>{conv.bannerText}</span> : null}
          </div>
        }
        error={conv.error}
        onLoadEarlier={conv.loadEarlier}
        hasMoreEarlier={conv.hasMoreEarlier}
        loadingEarlier={conv.loadingEarlier}
        onAnswerChoice={conv.answerChoice}
        conversationId={conv.conversationId ?? conversationId}
        workspaceId={workspaceId}
        harnessSlug={harnessSlug}
        emptyStateBody={`Starting a discussion about ${workItemId}…`}
        showQuickDraftPrompts={false}
      />
    </div>
  );
}

/** The explicit user intent sent once when a durable work-item thread is new. */
export function buildWorkItemDiscussionMessage(
  workItemId: string,
  title?: string | null,
): string {
  const compactTitle = title?.trim().replace(/\s+/g, " ").slice(0, 500);
  const subject = compactTitle ? `${workItemId} — ${compactTitle}` : workItemId;
  return `Let's discuss ${subject}. Explain what this work item currently needs from me and help me decide or complete the next concrete step.`;
}

export default function WorkItemDiscussion({
  harnessSlug,
  workItemId,
  title,
  onClose,
  focusWhenInteractive = false,
}: WorkItemDiscussionProps) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const workspaceId = useWorkspaceId();
  const targetKey = `${workspaceId}::${harnessSlug}::${workItemId}`;
  const identity = useSyncQuery<ConversationIdentity>({
    queryName: "operatorConversations.byWorkItem",
    args: { workspaceId, harness: harnessSlug, workItemId },
    enabled: Boolean(harnessSlug && workItemId),
    staleTime: 30_000,
  });
  const syncedId = identity.data?.[0]?.id?.trim() || null;
  const invalidateRef = useRef(identity.invalidate);
  invalidateRef.current = identity.invalidate;
  const [resolution, setResolution] = useState<LocalResolution | null>(null);
  const [retry, setRetry] = useState(0);
  const localId = resolution?.key === targetKey ? resolution.id : null;
  const error = resolution?.key === targetKey ? resolution.error : null;
  const conversationId = syncedId ?? localId;

  // Opening Discuss is the explicit mutation boundary. POST is idempotent, so
  // a reload/collapse race can safely repeat it and still reopen the same row.
  // The focused sync read above usually avoids the mutation on subsequent
  // mounts; POST also keeps the component functional outside a live SyncProvider.
  useEffect(() => {
    if (!harnessSlug || !workItemId || syncedId) return;
    const controller = new AbortController();
    let current = true;
    setResolution({ key: targetKey, id: null, error: null });

    void (async () => {
      try {
        const response = await fetch(
          `/api/operator/conversations/work-items/${encodeURIComponent(workItemId)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ harness: harnessSlug }),
            signal: controller.signal,
          },
        );
        const body = (await response.json().catch(() => null)) as {
          conversation?: { id?: unknown };
          error?: unknown;
        } | null;
        if (!response.ok) {
          throw new Error(
            typeof body?.error === "string"
              ? body.error
              : `HTTP ${response.status}`,
          );
        }
        const id =
          typeof body?.conversation?.id === "string"
            ? body.conversation.id.trim()
            : "";
        if (!id) throw new Error("The conversation endpoint returned no id.");
        if (!current) return;
        setResolution({ key: targetKey, id, error: null });
        invalidateRef.current?.();
      } catch (cause) {
        if (!current || controller.signal.aborted) return;
        setResolution({
          key: targetKey,
          id: null,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    })();

    return () => {
      current = false;
      controller.abort();
    };
  }, [harnessSlug, workItemId, syncedId, targetKey, retry]);

  const heading = useMemo(
    () => (title?.trim() ? `Discuss ${title.trim()}` : `Discuss ${workItemId}`),
    [title, workItemId],
  );

  useEffect(() => {
    if (!focusWhenInteractive) return;
    const section = sectionRef.current;
    if (!section) return;

    const focus = () => {
      if (!section.isConnected || section.closest("[inert]")) return false;
      section.focus({ preventScroll: true });
      return document.activeElement === section;
    };
    if (focus()) return;

    // A report's Discuss handoff writes the underlying Inbox URL state first,
    // so this section mounts while the routed pane is still inert. Observe only
    // the inert ancestors that currently block it, then focus immediately after
    // ReportTakeoverLayer releases the final one.
    const inertAncestors: HTMLElement[] = [];
    for (
      let ancestor = section.parentElement;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      if (ancestor.hasAttribute("inert")) inertAncestors.push(ancestor);
    }
    if (inertAncestors.length === 0) return;

    const observer = new MutationObserver(() => {
      if (focus()) observer.disconnect();
    });
    for (const ancestor of inertAncestors) {
      observer.observe(ancestor, {
        attributes: true,
        attributeFilter: ["inert"],
      });
    }
    return () => observer.disconnect();
  }, [focusWhenInteractive, targetKey]);

  return (
    <section
      ref={sectionRef}
      id={`work-item-discussion-${workItemId}`}
      className="wi-discussion"
      aria-label={`Papercup discussion for ${workItemId}`}
      data-testid={`work-item-discussion-${workItemId}`}
      tabIndex={focusWhenInteractive ? -1 : undefined}
    >
      <header className="wi-discussion__header">
        <span className="wi-discussion__mark" aria-hidden="true">
          <MessageCircle size={15} />
        </span>
        <span className="wi-discussion__heading">
          <strong>{heading}</strong>
          <span>Persisted Papercup thread · {harnessSlug}</span>
        </span>
        {onClose ? (
          <button
            type="button"
            className="wi-discussion__close"
            aria-label={`Close discussion for ${workItemId}`}
            onClick={onClose}
          >
            <X size={15} aria-hidden="true" />
          </button>
        ) : null}
      </header>

      {conversationId ? (
        <OperatorConversationProvider
          key={targetKey}
          target={{ kind: "work-item", conversationId }}
        >
          <WorkItemConversationChat
            harnessSlug={harnessSlug}
            workItemId={workItemId}
            title={title}
            conversationId={conversationId}
          />
        </OperatorConversationProvider>
      ) : error ? (
        <div
          className="wi-discussion__state wi-discussion__state--error"
          role="alert"
        >
          <span>Could not open this discussion: {error}</span>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            <RefreshCw size={13} aria-hidden="true" /> Retry
          </button>
        </div>
      ) : (
        <div className="wi-discussion__state" role="status">
          Opening the persisted discussion…
        </div>
      )}
    </section>
  );
}
