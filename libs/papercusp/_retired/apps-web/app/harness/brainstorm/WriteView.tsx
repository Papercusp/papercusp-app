'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import { toast } from 'sonner';

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

  // Load initial markdown
  useEffect(() => {
    let aborted = false;
    fetch(`/api/harness/${slug}/brainstorm`)
      .then((r) => r.json())
      .then(async (d) => {
        if (aborted) return;
        const md = typeof d.content === 'string' ? d.content : '';
        lastSavedRef.current = md;
        setInitialMd(md);
        if (md.trim() && editor) {
          try {
            const blocks = await editor.tryParseMarkdownToBlocks(md);
            editor.replaceBlocks(editor.document, blocks);
          } catch (e) {
            console.error('markdown parse failed', e);
          }
        }
        onMarkdownChange?.(md);
      })
      .catch((e) => toast.error(`Load failed: ${e}`));
    return () => { aborted = true; };
  }, [slug, editor]); // eslint-disable-line react-hooks/exhaustive-deps

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
