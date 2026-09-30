'use client';

import { JsonView, darkStyles } from 'react-json-view-lite';
import 'react-json-view-lite/dist/index.css';

// Dark-theme override tuned to our token palette.
const theme = {
  ...darkStyles,
  container: 'h-json',
};

export function JsonTree({ data }: { data: unknown }) {
  let parsed: unknown = data;
  if (typeof data === 'string') {
    try { parsed = JSON.parse(data); } catch { parsed = data; }
  }
  if (parsed === null || typeof parsed !== 'object') {
    return <pre style={{ margin: 0, fontSize: 11, color: 'var(--fg-dim)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{String(parsed ?? '')}</pre>;
  }
  return (
    <JsonView
      data={parsed as object}
      shouldExpandNode={(level) => level < 2}
      style={theme as any}
    />
  );
}
