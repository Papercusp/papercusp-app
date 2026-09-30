'use client';
import MDEditor from '@uiw/react-md-editor';

export default function UiwMdPane({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div data-color-mode="dark" style={{ height: '100%' }}>
      <MDEditor
        value={value}
        onChange={(v) => onChange(v ?? '')}
        height="100%"
        preview="live"
        visibleDragbar
      />
    </div>
  );
}
