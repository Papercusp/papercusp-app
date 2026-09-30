/**
 * NavChevrons — back/forward chevron buttons for panel chrome.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §6.2
 *
 * Panels that opt into useNavHistory pass `nav` here to render the
 * chevrons. Hidden entirely when canBack && canForward are both false —
 * the spec says no disabled buttons (don't render at all).
 */

'use client';

import { Tooltip } from '@/app/harness/Tooltip';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { NavHistory } from './useNavHistory';

interface NavChevronsProps<T> {
  nav: NavHistory<T>;
  /** Optional className for the row container. */
  className?: string;
}

export function NavChevrons<T>({ nav, className }: NavChevronsProps<T>) {
  if (!nav.canBack && !nav.canForward) return null;
  return (
    <div
      className={className}
      style={{
        display: 'inline-flex',
        gap: 2,
        marginRight: 8,
        alignItems: 'center',
      }}
    >
      <Tooltip label="Back (Cmd+[)"><button
        type="button"
        onClick={nav.back}
        disabled={!nav.canBack}
        aria-label="Back"

        style={chevronButtonStyle(nav.canBack)}
      >
        <ChevronLeft size={14} aria-hidden />
      </button></Tooltip>
      <Tooltip label="Forward (Cmd+])"><button
        type="button"
        onClick={nav.forward}
        disabled={!nav.canForward}
        aria-label="Forward"

        style={chevronButtonStyle(nav.canForward)}
      >
        <ChevronRight size={14} aria-hidden />
      </button></Tooltip>
    </div>
  );
}

function chevronButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 18,
    height: 18,
    padding: 0,
    background: 'transparent',
    border: 0,
    borderRadius: 3,
    cursor: enabled ? 'pointer' : 'default',
    color: enabled ? 'var(--fg)' : 'var(--fg-mute)',
    opacity: enabled ? 1 : 0.4,
  };
}

/**
 * Cmd+[ / Cmd+] keyboard shortcuts dispatcher. Mount once at the dock
 * root; reads the focused panel's nav via the registry (Phase 5+ work).
 *
 * Phase 6 wires this when DocsPanel + VSCodePanel get nav. For now,
 * panels can register their nav via setNavForPanel(id, nav).
 */
const focusedNavRegistry = new Map<string, NavHistory<unknown>>();

export function registerNavForPanel<T>(panelId: string, nav: NavHistory<T>): () => void {
  focusedNavRegistry.set(panelId, nav as NavHistory<unknown>);
  return () => {
    focusedNavRegistry.delete(panelId);
  };
}

export function getNavForPanel<T>(panelId: string): NavHistory<T> | undefined {
  return focusedNavRegistry.get(panelId) as NavHistory<T> | undefined;
}

export function _resetNavRegistryForTests(): void {
  focusedNavRegistry.clear();
}
