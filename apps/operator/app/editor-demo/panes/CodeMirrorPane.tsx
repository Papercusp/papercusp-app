'use client';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';

export default function CodeMirrorPane({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <CodeMirror
        value={value}
        onChange={onChange}
        theme={oneDark}
        extensions={[markdown(), EditorView.lineWrapping]}
        basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }}
        height="100%"
        style={{ fontSize: 13, minHeight: '100%' }}
      />
    </div>
  );
}
