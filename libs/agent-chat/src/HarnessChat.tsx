'use client';

import { ReactNode } from 'react';
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  ActionBarPrimitive,
  useThreadRuntime,
  useMessage,
} from '@assistant-ui/react';
import { Send, Square, RotateCcw, Copy, Pencil, Trash2 } from 'lucide-react';
import { useHarnessChatRuntime } from './useHarnessChatRuntime';

// Parse fenced blocks like ```patch:SPEC.md / ```note:supervisor / ```promote:feature
// Returns ordered parts of either plain text or an "action block."
export type ActionBlock = {
  kind: 'action';
  tag: string;          // "patch:SPEC.md" | "promote:feature" | ...
  content: string;
  blockKey: string;
};

const FENCE_RE = /```([a-z]+:[a-zA-Z0-9_.-]+)\s*\n([\s\S]*?)```/g;

export function splitActionBlocks(
  text: string,
  messageId: string,
): Array<{ kind: 'text'; text: string } | ActionBlock> {
  const out: Array<{ kind: 'text'; text: string } | ActionBlock> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    out.push({
      kind: 'action',
      tag: m[1],
      content: m[2].trim(),
      blockKey: `${messageId}-${m.index}`,
    });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  if (out.length === 0) out.push({ kind: 'text', text });
  return out;
}

export interface HarnessChatProps {
  slug: string;
  endpoint: string;          // e.g. "architect/chat"
  storageKey: string;        // localStorage key
  extraBody?: Record<string, unknown>;
  placeholder?: string;
  emptyHint?: ReactNode;
  renderActionBlock: (block: ActionBlock) => ReactNode;
  onThreadTitleInferred?: (title: string) => void;
  headerRight?: ReactNode;
}

export function HarnessChat(props: HarnessChatProps) {
  const chat = useHarnessChatRuntime({
    slug: props.slug,
    endpoint: props.endpoint,
    storageKey: props.storageKey,
    extraBody: props.extraBody,
    onThreadTitleInferred: props.onThreadTitleInferred,
  });

  return (
    <AssistantRuntimeProvider runtime={chat.runtime}>
      <ThreadShell
        emptyHint={props.emptyHint}
        placeholder={props.placeholder}
        renderActionBlock={props.renderActionBlock}
        headerRight={props.headerRight}
        onClear={chat.clear}
        hasMessages={chat.messages.length > 0}
      />
    </AssistantRuntimeProvider>
  );
}

function ThreadShell({
  emptyHint,
  placeholder,
  renderActionBlock,
  headerRight,
  onClear,
  hasMessages,
}: {
  emptyHint?: ReactNode;
  placeholder?: string;
  renderActionBlock: (block: ActionBlock) => ReactNode;
  headerRight?: ReactNode;
  onClear: () => void;
  hasMessages: boolean;
}) {
  return (
    <ThreadPrimitive.Root className="h-chat-root">
      <div className="h-chat-head">
        <div className="h-chat-head-actions">
          {hasMessages && (
            <button
              className="h-btn-icon"
              onClick={() => { if (confirm('Clear this conversation?')) onClear(); }}
              title="Clear conversation"
            >
              <Trash2 size={12} />
            </button>
          )}
          {headerRight}
        </div>
      </div>
      <ThreadPrimitive.Viewport className="h-chat-viewport">
        <ThreadPrimitive.Empty>
          <div className="h-chat-empty">{emptyHint ?? 'Start a conversation.'}</div>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages
          components={{
            UserMessage: () => <HChatMessage role="user" renderActionBlock={renderActionBlock} />,
            AssistantMessage: () => <HChatMessage role="assistant" renderActionBlock={renderActionBlock} />,
          }}
        />
        <ThreadPrimitive.If running>
          <AssistantStreamingCursor />
        </ThreadPrimitive.If>
      </ThreadPrimitive.Viewport>
      <Composer placeholder={placeholder} />
    </ThreadPrimitive.Root>
  );
}

function AssistantStreamingCursor() {
  return (
    <div className="h-chat-thinking">
      <span className="h-chat-cursor" /> streaming…
    </div>
  );
}

function HChatMessage({
  role,
  renderActionBlock,
}: {
  role: 'user' | 'assistant';
  renderActionBlock: (block: ActionBlock) => ReactNode;
}) {
  const m = useMessage();
  const text = m.content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('');
  const parts = splitActionBlocks(text, m.id);

  return (
    <MessagePrimitive.Root className={`h-chat-msg h-chat-${role}`}>
      <div className="h-chat-bubble">
        {parts.map((p, i) =>
          p.kind === 'text'
            ? <span key={i} className="h-chat-text">{p.text}</span>
            : <span key={i}>{renderActionBlock(p)}</span>
        )}
      </div>
      {role === 'assistant' && (
        <ActionBarPrimitive.Root className="h-chat-actions">
          <ActionBarPrimitive.Copy asChild>
            <button className="h-btn-icon" title="Copy"><Copy size={11} /></button>
          </ActionBarPrimitive.Copy>
          <ActionBarPrimitive.Reload asChild>
            <button className="h-btn-icon" title="Regenerate"><RotateCcw size={11} /></button>
          </ActionBarPrimitive.Reload>
        </ActionBarPrimitive.Root>
      )}
      {role === 'user' && (
        <ActionBarPrimitive.Root className="h-chat-actions">
          <ActionBarPrimitive.Edit asChild>
            <button className="h-btn-icon" title="Edit & resend"><Pencil size={11} /></button>
          </ActionBarPrimitive.Edit>
        </ActionBarPrimitive.Root>
      )}
    </MessagePrimitive.Root>
  );
}

function Composer({ placeholder }: { placeholder?: string }) {
  const runtime = useThreadRuntime();
  return (
    <ComposerPrimitive.Root className="h-chat-composer">
      <ComposerPrimitive.Input
        className="h-chat-input"
        placeholder={placeholder ?? 'Message…  (⌘↵ to send)'}
        rows={3}
        autoFocus
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            runtime.composer.send();
          }
        }}
      />
      <div className="h-chat-composer-actions">
        <span className="h-chat-hint">⌘↵</span>
        <ThreadPrimitive.If running>
          <ComposerPrimitive.Cancel asChild>
            <button className="h-btn danger" title="Stop (Esc)">
              <Square size={11} fill="currentColor" /> stop
            </button>
          </ComposerPrimitive.Cancel>
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running={false}>
          <ComposerPrimitive.Send asChild>
            <button className="h-btn primary">
              <Send size={11} /> send
            </button>
          </ComposerPrimitive.Send>
        </ThreadPrimitive.If>
      </div>
    </ComposerPrimitive.Root>
  );
}
