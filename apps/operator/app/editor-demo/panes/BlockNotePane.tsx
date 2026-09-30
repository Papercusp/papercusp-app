'use client';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import '@blocknote/mantine/style.css';
import { useEffect, useRef } from 'react';

export default function BlockNotePane({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const initial = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useCreateBlockNote();
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current || !editor) return;
    seeded.current = true;
    (async () => {
      const blocks = await editor.tryParseMarkdownToBlocks(initial.current);
      editor.replaceBlocks(editor.document, blocks);
    })();
  }, [editor]);

  return (
    <div style={{ height: '100%', overflow: 'auto', background: '#15181c' }}>
      <BlockNoteView
        editor={editor}
        theme="dark"
        onChange={() => {
          if (!seeded.current) return;
          // BlockNote 0.51: blocksToMarkdownLossy is now synchronous (returns string).
          onChangeRef.current(editor.blocksToMarkdownLossy(editor.document));
        }}
      />
    </div>
  );
}
