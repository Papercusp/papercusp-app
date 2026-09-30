'use client';
import Editor from '@monaco-editor/react';
// Points the Monaco AMD loader at our local mirror. Without it Monaco fetches
// ~4MB from jsdelivr on first mount (cdn-egress-fixes-2026-08-02 P-001).
import '@/app/_components/monaco-runtime';

export default function MonacoPane({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Editor
      height="100%"
      language="markdown"
      theme="vs-dark"
      value={value}
      onChange={(v) => onChange(v ?? '')}
      options={{
        wordWrap: 'on',
        minimap: { enabled: true },
        fontSize: 13,
        scrollBeyondLastLine: false,
      }}
    />
  );
}
