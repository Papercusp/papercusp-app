'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useExternalStoreRuntime,
  type ThreadMessageLike,
  type AppendMessage,
} from '@assistant-ui/react';
import { parseSseStream } from '@papercusp/sse';

export interface HarnessMsg {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

interface Options {
  slug: string;
  endpoint: string;                     // e.g. "architect/chat" or "brainstorm/chat"
  storageKey: string;                   // localStorage key for persistence
  extraBody?: Record<string, unknown>;  // reviewId, threadId, etc.
  onThreadTitleInferred?: (title: string) => void;
}

function toThreadMessage(m: HarnessMsg, i: number): ThreadMessageLike {
  return {
    id: `${m.ts}-${i}`,
    role: m.role,
    content: [{ type: 'text', text: m.content }],
    createdAt: new Date(m.ts),
  };
}

// Adapts our existing agent CLI SSE wire format (event: delta | event: done |
// event: error) into an assistant-ui external store runtime. The wire format
// is the same regardless of backend — runAgentChat normalizes both omp -p
// (--mode json) and claude -p (--output-format stream-json) into delta/done/error
// SSE events upstream. Messages round-trip through localStorage for persistence.
export function useHarnessChatRuntime(opts: Options) {
  const { slug, endpoint, storageKey, extraBody, onThreadTitleInferred } = opts;

  const [messages, setMessages] = useState<HarnessMsg[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [streamBuf, setStreamBuf] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const loadedRef = useRef(false);

  // load + persist
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      setMessages(raw ? JSON.parse(raw) : []);
    } catch { setMessages([]); }
    loadedRef.current = true;
  }, [storageKey]);

  useEffect(() => {
    if (!loadedRef.current) return;
    try { localStorage.setItem(storageKey, JSON.stringify(messages)); } catch {}
  }, [messages, storageKey]);

  const clear = useCallback(() => {
    setMessages([]);
    try { localStorage.removeItem(storageKey); } catch {}
  }, [storageKey]);

  const cancel = useCallback(async (): Promise<void> => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsRunning(false);
    // Flush in-flight partial to final assistant message
    setStreamBuf((buf) => {
      if (buf) {
        setMessages((prev) => [...prev, { role: 'assistant', content: buf + '\n\n⚠️ cancelled', ts: Date.now() }]);
      }
      return '';
    });
  }, []);

  const sendText = useCallback(async (text: string) => {
    if (!text.trim() || isRunning) return;

    const userMsg: HarnessMsg = { role: 'user', content: text, ts: Date.now() };
    const history = messages.slice(-10);
    const nextMsgs = [...messages, userMsg];
    setMessages(nextMsgs);
    setIsRunning(true);
    setStreamBuf('');

    if (messages.length === 0 && onThreadTitleInferred) {
      onThreadTitleInferred(text.slice(0, 60).replace(/\n/g, ' '));
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let accum = '';
    try {
      // Phase-4 T1.2: directly POST the projected-tool URL at
      // /api/agent-tools/<name-with-slashes> instead of the legacy
      // Hono shim at /api/harness/<slug>/<endpoint>. The harness
      // slug now ships in the body (the tools declared harnessSlug
      // as a required arg post-round-12 migration). Accept header
      // pins SSE — the catch-all returns JSON on missing accept,
      // which would buffer the whole turn before responding.
      const res = await fetch(`/api/agent-tools/${endpoint}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'text/event-stream',
        },
        body: JSON.stringify({
          harnessSlug: slug,
          history,
          message: text,
          ...(extraBody ?? {}),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`${res.status} ${await res.text().catch(() => '')}`);

      // parseSseStream is spec-compliant: multi-line data: lines join with
      // \n natively, so the prior `replace(/\\n/g, '\n')` dance is no longer
      // needed. Same wire format on the server — no producer change required.
      for await (const ev of parseSseStream(res.body)) {
        if (ev.event === 'delta') {
          accum += ev.data;
          setStreamBuf(accum);
        } else if (ev.event === 'error') {
          accum += `\n\n⚠️ ${ev.data}`;
          setStreamBuf(accum);
        }
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        // Already handled in cancel()
        return;
      }
      accum += `\n\n⚠️ chat failed: ${e?.message ?? e}`;
    } finally {
      abortRef.current = null;
    }

    const asstMsg: HarnessMsg = { role: 'assistant', content: accum || '(no reply)', ts: Date.now() };
    setMessages((prev) => [...prev, asstMsg]);
    setStreamBuf('');
    setIsRunning(false);
  }, [messages, isRunning, slug, endpoint, extraBody, onThreadTitleInferred]);

  const onNew = useCallback(async (message: AppendMessage) => {
    const text = message.content
      .filter((p) => p.type === 'text')
      .map((p) => (p as { type: 'text'; text: string }).text)
      .join('\n');
    await sendText(text);
  }, [sendText]);

  // Assemble the thread messages for the runtime. Include the in-flight
  // assistant partial as the latest message while streaming.
  const threadMessages: ThreadMessageLike[] = messages.map(toThreadMessage);
  if (isRunning && streamBuf) {
    threadMessages.push({
      id: 'streaming',
      role: 'assistant',
      content: [{ type: 'text', text: streamBuf }],
      createdAt: new Date(),
    });
  }

  const runtime = useExternalStoreRuntime({
    isRunning,
    messages: threadMessages,
    onNew,
    onCancel: cancel,
    convertMessage: (m) => m as ThreadMessageLike,
  });

  return {
    runtime,
    messages,
    isRunning,
    streamBuf,
    clear,
    cancel,
    sendText,
  };
}
