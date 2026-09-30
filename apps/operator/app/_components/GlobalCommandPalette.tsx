'use client';

/**
 * App-wide command palette host.
 *
 * Owns the palette's open state and the `palette.toggle` keyboard
 * binding (⌘K / Ctrl+P / ⌘/ — see `lib/shortcut-registry.ts`). Mounted
 * once at the app root (`app/layout.tsx`, inside <NuqsAdapter>), so
 * Ctrl+P opens the palette on EVERY route — not just the harness
 * dashboard, which is where the old handler lived before it was deleted
 * with HarnessDashboard.
 *
 * Open state lives in the URL (`?palette=true` — parseAsBoolean only parses
 * the literal string "true"; `?palette=1` reads as closed) via nuqs — per the repo's
 * "user-meaningful state goes in the URL" rule it's deep-linkable and
 * agent-driveable (ui:dispatch can open the palette). nuqs defaults to
 * `history: 'replace'`, so toggling the palette does NOT push a history
 * entry — important now that Alt+Left/Right traverse browser history.
 *
 * The palette UI is lazy: its chunk (cmdk + Radix Dialog) only loads the
 * first time the user opens it, keeping it off the first-paint path of
 * every page.
 */
import { Component, Suspense, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { parseAsBoolean, useQueryState } from 'nuqs';
import { useSearchParams } from '@/lib/router-compat/navigation';
import { toast } from 'sonner';
import { lazyWithRetry } from '@papercusp/operator-core/lib/lazy-with-retry';
import { beginInteraction, PERF_INTERACTIONS } from './perf/perf-marks';
import { useShortcutAction } from '../../lib/hotkeys';
import { buildRegistryPaletteItems } from '@papercusp/operator-core/lib/commands/shims/palette-shim';
import { useServerCapabilityCommands } from './use-server-capabilities';
import type { Command } from './CommandPalette';

const CommandPalette = lazyWithRetry(() => import('./CommandPalette'));

/**
 * Catches a failed dynamic import of the palette chunk. In dev, the background
 * `vite build --watch` (`dev:nohmr`) deletes the chunk hashes an already-open
 * desktop window loaded, so reopening the palette 404s; `lazyWithRetry` retries
 * then rejects — it deliberately does NOT auto-reload on the desktop / :3070
 * origin (DevReloadGate owns the no-auto-reload policy). Without this boundary
 * that rejection throws past <Suspense> and could unmount the app root. Instead
 * we close the palette and tell the user to reload. Production never hits this
 * (no mid-session rebuilds), so it's a dev-ergonomics safety net.
 */
class PaletteChunkBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default function GlobalCommandPalette() {
  const [open, setOpen] = useQueryState('palette', parseAsBoolean.withDefault(false));
  const searchParams = useSearchParams();
  const workspace = searchParams?.get('ws') ?? 'default';

  // Perf-marks (P-006): begin the command-palette-open interaction the moment
  // `open` transitions false→true, from ANY open path (⌘K/Ctrl+P, a click, or a
  // URL/agent ?palette=true deep-link). The matching endInteraction fires when
  // the lazy CommandPalette chunk mounts, so the measure spans the dynamic-import
  // + first-render cost. Single source (not the toggle handler) so it can't
  // double-fire and reset the start mark.
  //
  // useLayoutEffect, not useEffect — the begin/end pair here spans TWO
  // components, and React runs effects child-before-parent within a phase. The
  // end lives in the lazy CommandPalette's mount effect, so if that chunk is
  // already resolved and mounts in the SAME commit as this open transition, a
  // passive begin runs AFTER the child's end: the end no-ops (no start yet),
  // the start is then written and never consumed, and this interaction
  // silently measures NOTHING. Today the dynamic import usually forces a later
  // commit and hides that, which makes it a latent trap rather than a safe
  // pattern. All layout effects run before ANY passive effect, so beginning
  // here is ordered against every child settle regardless.
  //
  // Same defect class as the learning-view-switch begin, where it was not
  // latent: it emitted a 15,289ms measure against a 1500ms budget
  // (EI-19375505819043214). Ordering rationale + the general contract live in
  // perf-marks.ts.
  const prevOpenRef = useRef(false);
  useLayoutEffect(() => {
    if (open && !prevOpenRef.current) beginInteraction(PERF_INTERACTIONS.commandPaletteOpen);
    prevOpenRef.current = open;
  }, [open]);

  // Toggle on the registry's `palette.toggle` combo. `enableOnFormTags`
  // matches the registry def so the palette opens even while focus is in
  // a text input (e.g. the operator chat composer or a vditor editor).
  useShortcutAction(
    'palette.toggle',
    () => { void setOpen((o) => !o); },
    { enableOnFormTags: ['INPUT', 'TEXTAREA'] },
  );

  // Browser-reflexive rows from the Action Registry — every command tagged
  // with a `paletteEntry` (nav.*, operator.*, panel.*). Memoized by workspace
  // so the perform() closures capture the active ws; cheap to rebuild.
  const registryCommands = useMemo<Command[]>(() => {
    const sessionId = typeof window !== 'undefined'
      ? (window.sessionStorage.getItem('pc-voice-tab-id') ?? undefined)
      : undefined;
    return buildRegistryPaletteItems({ workspace, sessionId }).map((it) => ({
      id: it.id,
      title: it.title,
      section: it.section,
      icon: it.icon,
      keywords: it.keywords,
      perform: it.perform,
    }));
  }, [workspace]);

  // Server tool catalog (the agent tools) — the §3-eligible, principal-gated
  // subset, fetched the first time the palette opens. Executes via the gated
  // /run-tool endpoint. This is the unification payoff: Ctrl+P now spans both
  // the browser commands AND the agent catalog.
  const serverCommands = useServerCapabilityCommands(open);

  const commands = useMemo<Command[]>(
    () => [...registryCommands, ...serverCommands],
    [registryCommands, serverCommands],
  );

  // Don't mount the lazy palette chunk until first open.
  if (!open) return null;
  return (
    <PaletteChunkBoundary
      onError={() => {
        toast('Command palette updated — reload (Ctrl/⌘R) to use it.');
        void setOpen(false);
      }}
    >
      <Suspense fallback={null}>
        <CommandPalette open onClose={() => { void setOpen(false); }} commands={commands} />
      </Suspense>
    </PaletteChunkBoundary>
  );
}
