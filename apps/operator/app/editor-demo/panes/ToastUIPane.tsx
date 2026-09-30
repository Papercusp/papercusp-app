'use client';
import { Editor } from '@toast-ui/react-editor';
import '@toast-ui/editor/dist/toastui-editor.css';
import '@toast-ui/editor/dist/theme/toastui-editor-dark.css';
import { useEffect, useRef } from 'react';

export default function ToastUIPane({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<Editor>(null);
  const initial = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const inst = ref.current?.getInstance();
    if (!inst) return;
    const handler = () => onChangeRef.current(inst.getMarkdown());
    inst.on('change', handler);
    return () => { inst.off('change'); };
  }, []);

  return (
    <div style={{ height: '100%', overflow: 'hidden', background: '#15181c' }}>
      <Editor
        ref={ref}
        initialValue={initial.current}
        previewStyle="vertical"
        height="100%"
        initialEditType="wysiwyg"
        useCommandShortcut={true}
        theme="dark"
      />
    </div>
  );
}
