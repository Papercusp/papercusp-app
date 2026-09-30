'use client';

import { useEffect, useMemo, useRef, useState, KeyboardEvent } from 'react';
import { KbdHint } from './primitives';

export interface Command {
  id: string;
  title: string;
  subtitle?: string;
  section?: string;
  keywords?: string;
  icon?: string;
  shortcut?: string;
  perform: () => void;
}

function score(query: string, c: Command): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const title = c.title.toLowerCase();
  const subtitle = (c.subtitle ?? '').toLowerCase();
  const kws = (c.keywords ?? '').toLowerCase();
  const hay = `${title} ${subtitle} ${kws}`;

  let s = 0;
  if (title.startsWith(q)) s += 100;
  if (title.includes(q)) s += 50;
  if (subtitle.includes(q)) s += 20;
  if (kws.includes(q)) s += 10;

  // Subsequence match: each letter of q appears in order in hay.
  let i = 0, j = 0;
  while (i < q.length && j < hay.length) {
    if (q[i] === hay[j]) i++;
    j++;
  }
  if (i === q.length) s += 5;

  return s;
}

export default function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const filtered = useMemo(() => {
    if (!query.trim()) {
      return commands.slice(0, 60);
    }
    return commands
      .map((c) => ({ c, s: score(query, c) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((x) => x.c);
  }, [commands, query]);

  useEffect(() => {
    if (selected >= filtered.length) setSelected(Math.max(0, filtered.length - 1));
  }, [filtered.length, selected]);

  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-cmd-idx="${selected}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!open) return null;

  const hasQuery = query.trim().length > 0;
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = filtered[selected];
      if (cmd) { cmd.perform(); onClose(); }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  let lastSection: string | undefined = undefined;

  return (
    <div className="h-cmd-overlay" onClick={onClose}>
      <div
        className="h-cmd"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-cmd-inputbar">
          <span className="h-cmd-key">⌘K</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Type a command, feature, run, or project…"
            className="h-cmd-input"
            aria-label="Search commands"
          />
          {query && (
            <button className="h-cmd-clear" type="button" onClick={() => setQuery('')}>
              clear
            </button>
          )}
          <span className="h-cmd-esc">esc</span>
        </div>

        <div className="h-cmd-meta">
          <span>{hasQuery ? `${filtered.length} match${filtered.length === 1 ? '' : 'es'}` : 'quick actions'}</span>
          <span>Search projects, features, runs, and workspace controls.</span>
        </div>

        <div ref={listRef} className="h-cmd-list" role="listbox">
          {filtered.length === 0 ? (
            <div className="h-cmd-empty">
              <strong>No matches</strong>
              <span>Try “start”, “triage”, “docs”, a feature id, or a project name.</span>
            </div>
          ) : (
            filtered.map((c, idx) => {
              const showSection = !hasQuery && c.section && c.section !== lastSection;
              lastSection = c.section;
              const selectedRow = idx === selected;
              return (
                <div key={c.id} className="h-cmd-row-wrap">
                  {showSection && <div className="h-cmd-section">{c.section}</div>}
                  <button
                    type="button"
                    data-cmd-idx={idx}
                    className={`h-cmd-row${selectedRow ? ' selected' : ''}`}
                    role="option"
                    aria-selected={selectedRow}
                    onClick={() => { c.perform(); onClose(); }}
                    onMouseEnter={() => setSelected(idx)}
                  >
                    <span className="h-cmd-icon" aria-hidden="true">{c.icon ?? '⌁'}</span>
                    <span className="h-cmd-copy">
                      <span className="h-cmd-title">{c.title}</span>
                      {c.subtitle && <span className="h-cmd-subtitle">{c.subtitle}</span>}
                    </span>
                    {c.shortcut && <KbdHint>{c.shortcut}</KbdHint>}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="h-cmd-footer">
          <span><KbdHint>↑↓</KbdHint> navigate</span>
          <span><KbdHint>↵</KbdHint> run</span>
          <span><KbdHint>esc</KbdHint> close</span>
        </div>
      </div>
    </div>
  );
}
