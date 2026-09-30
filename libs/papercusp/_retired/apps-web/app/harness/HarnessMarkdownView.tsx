'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function expandWikiLinks(md: string): string {
  return (md ?? '').replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_m, raw, label) => {
    const target = String(raw ?? '').trim();
    const display = String(label ?? target).trim();
    const params = new URLSearchParams({ target });
    return `[${display}](/wiki?${params.toString()})`;
  });
}

export function HarnessMarkdownView({
  value,
  className,
  style,
  emptyLabel = 'No markdown content.',
}: {
  value: string | null | undefined;
  className?: string;
  style?: React.CSSProperties;
  emptyLabel?: string;
}) {
  const markdown = (value ?? '').trim() ? (value ?? '') : `_${emptyLabel}_`;

  return (
    <div className={`vditor-reset h-markdown-view ${className ?? ''}`} style={style}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{expandWikiLinks(markdown)}</ReactMarkdown>
    </div>
  );
}
