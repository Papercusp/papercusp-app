"use client";

import { useEffect, useRef } from "react";

function pageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/**
 * Run `refresh` now and then every `intervalMs` — but ONLY while the page is
 * visible and `enabled` holds. Hidden tab, closed grid: no timer, no request.
 *
 * This is what makes a grid's thumbnails cost nothing when nobody is looking
 * (plan agent-multi-desktops-grid P-005: a capture happens only because a grid
 * asked). On becoming visible again it refreshes at once instead of showing
 * frames from before the tab was hidden.
 *
 * A setTimeout chain rather than setInterval: each tick is scheduled after the
 * last one ran, so a slow render never stacks ticks behind it.
 */
export function useVisibleRefresh(
  refresh: () => void,
  intervalMs: number,
  enabled: boolean,
): void {
  const latest = useRef(refresh);
  latest.current = refresh;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const tick = () => {
      timer = null;
      if (!pageVisible()) return;
      latest.current();
      timer = setTimeout(tick, intervalMs);
    };
    const onVisibility = () => {
      stop();
      if (pageVisible()) tick();
    };
    tick();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalMs]);
}
