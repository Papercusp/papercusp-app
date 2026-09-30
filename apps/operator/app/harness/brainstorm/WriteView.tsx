'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import { toast } from 'sonner';
import { useSyncQuery } from '@papercusp/sync';

type BrainstormRow = { harnessSlug: string; phase: string; content: string; canvas: unknown; mindmap: unknown; updatedAt: number };

interface Props {
  slug: string;
  onMarkdownChange?: (md: string) => void;
}

// Debounce helper (inline to avoid a dep)
function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return ((...args: any[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

export function WriteView({ slug, onMarkdownChange }: Props) {
  const [initialMd, setInitialMd] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const lastSavedRef = useRef<string>('');

  const editor = useCreateBlockNote({
    initialContent: undefined,
  });

  // Eager subscription to the brainstorm row for this harness. Replaces
  // the per-mount REST fetch so the editor populates same-frame on open
  // (and follows changes from other tabs via SSE invalidate).
  const { data: brainstormRows } = useSyncQuery<BrainstormRow>({
    queryName: 'harnessBrainstorm.byHarness',
    args: { harnessSlug: slug },
    enabled: !!slug,
  });
  const brainstormRow = useMemo(
    () => Array.isArray(brainstormRows) ? brainstormRows.find((r) => r.phase === 'staging') ?? brainstormRows[0] : undefined,
    [brainstormRows],
  );

  // Hydrate the BlockNote editor when the row arrives (and only once per
  // distinct content — replaceBlocks resets editor state, so we guard
  // against re-running on irrelevant row updates).
  useEffect(() => {
    if (!brainstormRow || !editor) return;
    let aborted = false;
    const md = typeof brainstormRow.content === 'string' ? brainstormRow.content : '';
    if (md === lastSavedRef.current && initialMd !== null) return;
    lastSavedRef.current = md;
    setInitialMd(md);
    if (md.trim()) {
      Promise.resolve(editor.tryParseMarkdownToBlocks(md)).then((blocks) => {
        if (!aborted) editor.replaceBlocks(editor.document, blocks);
      }).catch((e: unknown) => console.error('markdown parse failed', e));
    }
    onMarkdownChange?.(md);
    return () => { aborted = true; };
  }, [brainstormRow, editor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save on change (debounced)
  const save = useMemo(() =>
    debounce(async (md: string) => {
      if (md === lastSavedRef.current) return;
      setSaveState('saving');
      try {
        const res = await fetch(`/api/harness/${slug}/brainstorm`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: md }),
        });
        if (!res.ok) throw new Error(await res.text());
        lastSavedRef.current = md;
        setSaveState('saved');
        setTimeout(() => setSaveState((s) => s === 'saved' ? 'idle' : s), 1500);
      } catch (e: any) {
        setSaveState('error');
        toast.error(`Save failed: ${e?.message ?? e}`);
      }
    }, 600), [slug]);

  useEffect(() => {
    if (!editor) return;
    const handler = async () => {
      try {
        const md = await editor.blocksToMarkdownLossy(editor.document);
        onMarkdownChange?.(md);
        save(md);
      } catch {}
    };
    const unsubscribe = editor.onChange(handler);
    return () => { if (typeof unsubscribe === 'function') unsubscribe(); };
  }, [editor, onMarkdownChange, save]);

  if (initialMd === null) {
    return <div className="h-empty">loading brainstorm…</div>;
  }

  return (
    <div className="h-brainstorm-write">
      <div className="h-brainstorm-savehint">
        {saveState === 'saving' && <span>saving…</span>}
        {saveState === 'saved' && <span>✓ saved</span>}
        {saveState === 'error' && <span style={{ color: 'var(--bad)' }}>save failed</span>}
      </div>
      <BlockNoteView editor={editor} theme="dark" />
    </div>
  );
}
