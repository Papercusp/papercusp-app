'use client';
import { MarkdownEditor } from '@/app/_components/MarkdownEditor';

export default function VditorPane({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ height: '100%', background: '#15181c' }}>
      <MarkdownEditor value={value} onChange={onChange} mode="ir" outline="left" />
    </div>
  );
}
