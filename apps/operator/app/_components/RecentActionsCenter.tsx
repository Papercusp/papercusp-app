'use client';

import { useCallback, useEffect, useState } from 'react';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { useQueryState, parseAsBoolean } from 'nuqs';
import { Activity, X } from 'lucide-react';
import { OperatorActionLog } from './OperatorActionLog';
import { Popover } from '../harness/Popover';

/**
 * Recent-actions popover. Mirrors the NotificationCenter bell pattern
 * (button + dropdown anchored top-right of pc-header). Replaces the
 * old in-dashboard `<LazyDetails><OperatorActionLog/></LazyDetails>`
 * block that lived at the bottom of the harness page.
 *
 * The popover only shows when the user clicks the button — no badge,
 * no polling on close (the OperatorActionLog component handles its
 * own polling once mounted, and unmounts when the popover closes).
 *
 * Pulls the active harness slug from the URL (`?slug=`, `?project=`,
 * or `/harness/<slug>` path) so it can render outside HarnessDashboard.
 */
export function readActiveSlug(): string | null {
  if (typeof window === 'undefined') return null;
  const isValid = (s: string | null | undefined) =>
    !!s && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(s);
  try {
    const url = new URL(window.location.href);
    const fromSlug = url.searchParams.get('slug') ?? url.searchParams.get('project');
    if (isValid(fromSlug)) return fromSlug as string;
    const m = url.pathname.match(/\/harness\/([a-z0-9][a-z0-9._-]{0,63})\b/i);
    if (m) return m[1];
  } catch { /* ignore */ }
  // Fallback: HarnessDashboard persists the active harness here whenever
  // the user picks one (see `harness.activeProject` write in
  // HarnessDashboard.tsx). Without this, opening the popover from a
  // route that doesn't carry `?slug=` (most of /harness in practice)
  // would always show "Pick a harness…" even though the dashboard
  // clearly has one selected.
  try {
    const saved = window.localStorage.getItem(wsLocalKey('harness.activeProject'));
    if (isValid(saved)) return saved;
  } catch { /* ignore */ }
  return null;
}

export function RecentActionsCenter() {
  const [open, setOpen] = useQueryState('recent', parseAsBoolean.withDefault(false));
  const [slug, setSlug] = useState<string | null>(null);
  // Outside-click + ESC handled by Radix Popover via harness/Popover wrapper.

  // Re-read slug whenever the popover is opened so it follows the
  // user's current harness without needing parent state. Also re-read
  // on URL changes (`popstate`).
  useEffect(() => {
    const next = readActiveSlug();
    setSlug(next);
    const onPop = () => {
      const fresh = readActiveSlug();
      setSlug(fresh);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    if (open) {
      const fresh = readActiveSlug();
      setSlug(fresh);
    }
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  return (
    <div className="notif-center">
      <Popover
        open={open}
        onOpenChange={setOpen}
        ariaLabel="Recent actions"
        tooltipLabel="Recent actions (replan, cleanup, snapshots, plugin ops)"
        side="bottom"
        align="end"
        sideOffset={8}
        zIndex={1400}
        contentClassName="notif-panel"
        trigger={
          <button
            type="button"
            className="notif-bell"
            aria-label="Recent actions"
          >
            <Activity size={16} aria-hidden="true" />
          </button>
        }
      >
          <div className="notif-panel-head">
            <span>Recent actions {slug && <span style={{ opacity: 0.6, fontWeight: 400 }}>· {slug}</span>}</span>
            <button
              type="button"
              className="notif-panel-action"
              onClick={close}
              aria-label="Close"
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
          <div
            className="notif-panel-body"
            style={{ padding: slug ? '4px 8px 8px' : 12 }}
          >
            {slug ? (
              <OperatorActionLog slug={slug} />
            ) : (
              <div className="notif-empty" style={{ padding: '20px 4px' }}>
                Pick a harness to see its action log.
              </div>
            )}
          </div>
      </Popover>
    </div>
  );
}
