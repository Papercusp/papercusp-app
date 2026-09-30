'use client';

/**
 * Command palette (⌘K / Ctrl+P) — app-wide.
 *
 * Restored from the version that lived at `app/harness/CommandPalette.tsx`
 * until the HarnessDashboard removal (commit e93fc3a9, 2026-05-30) took
 * it down along with the only component that mounted it. It now lives in
 * `_components` and is mounted at the app root by `GlobalCommandPalette`,
 * so the palette opens on every route — not just the harness dashboard.
 *
 * Styling lives in `app/command-palette.css` (imported app-wide from
 * `app/layout.tsx`); the `.h-cmd*` class names are unchanged so the
 * markup matches the original chrome verbatim.
 */
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Command as CmdK } from 'cmdk';
import { endInteraction, PERF_INTERACTIONS } from './perf/perf-marks';
import { useLexicon } from '../../lib/useLexicon';

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

/** Tiny inline keycap — keeps the palette self-contained (no dependency
 *  on the harness-scoped `primitives` module, which pulls in Tooltip). */
function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="h-cmd-kbd">{children}</kbd>;
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
  const t = useLexicon();
  // Defer the heavy command list. The palette dialog mounts and the
  // input becomes interactive on the first paint; the items render on
  // a subsequent low-priority React render.
  const deferredCommands = useDeferredValue(commands);

  // Focus the input on open. We're using forceMount so the dialog
  // tree is always in the DOM — Radix's onOpenAutoFocus doesn't
  // reliably fire in that mode, so we drive focus from `open`.
  // requestAnimationFrame lets Radix flip data-state="open" + the CSS
  // visibility:hidden override clear before we focus; Firefox refuses
  // to move focus to an element that's still computed-hidden.
  const inputRef = useRef<HTMLInputElement>(null);

  // Perf-marks (P-006): end the command-palette-open interaction on first mount.
  // GlobalCommandPalette lazy-mounts this component only on the first open, so a
  // mount-once effect closes the measure that its open-transition effect began —
  // the span covers the dynamic cmdk+Radix chunk import + first render. No-op
  // unless a matching beginInteraction ran (measure-once guard), so it never
  // emits a stray measure.
  useEffect(() => {
    endInteraction(PERF_INTERACTIONS.commandPaletteOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Clear the search input when closing so the next open starts fresh.
  useEffect(() => {
    if (!open && inputRef.current) inputRef.current.value = '';
  }, [open]);

  // Pin `run` to a stable identity so the memoized CommandList doesn't
  // re-render every time the parent re-renders.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const run = useCallback((c: Command) => {
    c.perform();
    onCloseRef.current();
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }} modal={false}>
      {/*
        forceMount keeps the dialog tree in the DOM (just hidden) so
        opening is a CSS state toggle instead of a fresh mount + render
        of the cmdk items + Radix portal scaffolding.
      */}
      <Dialog.Portal forceMount>
        <Dialog.Overlay className="h-cmd-overlay" data-anim="fade" forceMount />
        <Dialog.Content
          forceMount
          className="h-cmd"
          data-anim="slide-down"
          aria-label="Command palette"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            const input = (e.currentTarget as HTMLElement).querySelector('input[cmdk-input]') as HTMLInputElement | null;
            input?.focus();
          }}
        >
          <Dialog.Description style={SR_ONLY}>Search commands, {t('pot', { plural: true, lower: true })}, and actions</Dialog.Description>
          <Dialog.Title style={SR_ONLY}>Command palette</Dialog.Title>
          <CmdK label="Command palette" loop shouldFilter>
            <div className="h-cmd-inputbar">
              <span className="h-cmd-key">⌘K</span>
              <CmdK.Input
                ref={inputRef}
                className="h-cmd-input"
                placeholder="Type a command, feature, run, or project…"
                aria-label="Search commands"
              />
              <span className="h-cmd-esc">esc</span>
            </div>

            <div className="h-cmd-meta">
              <span>quick actions</span>
              <span>Search projects, features, runs, and workspace controls.</span>
            </div>

            <CmdK.List className="h-cmd-list">
              <CmdK.Empty className="h-cmd-empty">
                <strong>No matches</strong>
                <span>Try “start”, “triage”, “docs”, a feature id, or a project name.</span>
              </CmdK.Empty>

              <CommandList commands={deferredCommands} run={run} />
            </CmdK.List>

            <div className="h-cmd-footer">
              <span><Kbd>↑↓</Kbd> navigate</span>
              <span><Kbd>↵</Kbd> run</span>
              <span><Kbd>esc</Kbd> close</span>
            </div>
          </CmdK>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const SR_ONLY: CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0,
};

/**
 * The command list is split out + memoized so React's deferred-render
 * scheduler can keep the dialog shell paint-priority while this mounts
 * its (potentially many) `<CmdK.Item>` children at low priority.
 */
const CommandList = memo(function CommandList({
  commands,
  run,
}: {
  commands: Command[];
  run: (c: Command) => void;
}) {
  const grouped = useMemo(() => {
    const groups = new Map<string, Command[]>();
    for (const c of commands) {
      const key = c.section ?? '';
      const arr = groups.get(key);
      if (arr) arr.push(c);
      else groups.set(key, [c]);
    }
    return Array.from(groups.entries());
  }, [commands]);

  return (
    <>
      {grouped.map(([section, cmds]) => (
        <CmdK.Group key={section || 'default'} heading={section || undefined} className="h-cmd-group">
          {cmds.map((c) => (
            <CmdK.Item
              key={c.id}
              value={`${c.title} ${c.subtitle ?? ''} ${c.keywords ?? ''}`}
              onSelect={() => run(c)}
              className="h-cmd-row"
            >
              <span className="h-cmd-icon" aria-hidden="true">{c.icon ?? '⌁'}</span>
              <span className="h-cmd-copy">
                <span className="h-cmd-title">{c.title}</span>
                {c.subtitle && <span className="h-cmd-subtitle">{c.subtitle}</span>}
              </span>
              {c.shortcut && <Kbd>{c.shortcut}</Kbd>}
            </CmdK.Item>
          ))}
        </CmdK.Group>
      ))}
    </>
  );
});
